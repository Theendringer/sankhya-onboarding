import type { IncomingMessage, ServerResponse } from 'http';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

interface VercelRequest extends IncomingMessage {
  query: { [key: string]: string | string[] };
  headers: { [key: string]: string | undefined };
  url?: string;
  method?: string;
}

interface VercelResponse extends ServerResponse {
  status: (code: number) => VercelResponse;
  json: (data: any) => void;
  send: (data: any) => void;
}

function getFirestore(): admin.firestore.Firestore {
  if (admin.apps.length > 0 && admin.apps[0]) {
    return admin.firestore();
  }

  let credentials: any = null;

  // 1. Tenta carregar pela variável de ambiente FIREBASE_SERVICE_ACCOUNT (Vercel)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err: any) {
      console.warn('Falha ao processar FIREBASE_SERVICE_ACCOUNT:', err.message);
    }
  }
  // 1.1 Suporte adicional para FIREBASE_SERVICE_ACCOUNT_KEY (retrocompatibilidade)
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
      credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    } catch (err: any) {
      console.warn('Falha ao processar FIREBASE_SERVICE_ACCOUNT_KEY:', err.message);
    }
  }
  // 2. Tenta variáveis individuais (fallback)
  else if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    credentials = {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_PROJECT_ID,
    };
  }
  // 3. Fallback para arquivo físico local (localhost)
  else {
    const possiblePaths = [
      path.resolve(process.cwd(), 'firebase-key.json'),
      path.resolve(__dirname, '..', 'firebase-key.json'),
      path.resolve(__dirname, 'firebase-key.json')
    ];

    for (const filePath of possiblePaths) {
      if (fs.existsSync(filePath)) {
        try {
          const fileContent = fs.readFileSync(filePath, 'utf-8');
          credentials = JSON.parse(fileContent);
          break;
        } catch (err) {
          console.warn(`Erro ao ler ${filePath}:`, err);
        }
      }
    }
  }

  if (credentials) {
    // Garante a correção de quebras de linha da chave privada
    if (credentials.private_key) {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }

    try {
      admin.initializeApp({
        credential: admin.credential.cert(credentials)
      });
      return admin.firestore();
    } catch (err) {
      console.warn('Erro ao inicializar Firebase Admin com credenciais fornecidas:', err);
    }
  }

  admin.initializeApp();
  return admin.firestore();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).send('OK');

  try {
    let id: string | undefined;
    let token: string | undefined;

    if (req.url) {
      const parsedUrl = new URL(req.url, 'http://localhost');
      id = parsedUrl.searchParams.get('id') || undefined;
      token = parsedUrl.searchParams.get('token') || undefined;
    }

    if (!id && req.query) {
      id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
      token = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
    }

    if (!id || !token) {
      return renderHtmlResponse(res, 400, 'Parâmetros Inválidos', 'ID e Token são obrigatórios.', 'error');
    }

    const db = getFirestore();
    const docRef = db.collection('onboardings').doc(id);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return renderHtmlResponse(res, 404, 'Registro Não Encontrado', `Nenhuma solicitação encontrada com ID: ${id}`, 'error');
    }

    const data = docSnap.data();
    if (data?.token !== token) {
      return renderHtmlResponse(res, 403, 'Acesso Não Autorizado', 'Token de segurança inválido.', 'error');
    }

    const now = new Date().toISOString();
    await docRef.update({
      status: 'REJEITADO',
      rejeitadoEm: now,
      updatedAt: now
    });

    return renderHtmlResponse(
      res,
      200,
      'Solicitação Rejeitada',
      `A solicitação de implantação da empresa <strong>${data?.params?.nomeEmpresa || 'Cliente'}</strong> foi marcada como <strong>REJEITADA</strong> no Firestore. Nenhum script foi disparado ao cliente.`,
      'rejected',
      data?.params
    );
  } catch (error: any) {
    console.error('[ERRO api/rejeitar]:', error);
    return renderHtmlResponse(res, 500, 'Erro no Processamento', `Erro interno: ${error?.message || String(error)}`, 'error');
  }
}

function renderHtmlResponse(res: VercelResponse, statusCode: number, title: string, message: string, type: 'rejected' | 'error', params?: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const isRejected = type === 'rejected';

  const html = `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8">
    <title>${title} &bull; Onboarding Sankhya x Hub</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-slate-100 min-h-screen flex items-center justify-center p-4">
    <div class="max-w-lg w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-200">
      <div class="${isRejected ? 'bg-amber-600' : 'bg-rose-600'} p-6 text-white text-center">
        <h1 class="text-xl font-bold">${title}</h1>
        <p class="text-xs opacity-90 mt-1">Sankhya x Hub Implantação</p>
      </div>
      <div class="p-6">
        <p class="text-slate-600 text-sm leading-relaxed mb-6">${message}</p>
        ${params ? `
          <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs space-y-1.5 font-mono mb-6 text-slate-700">
            <div><strong>Empresa:</strong> ${params.nomeEmpresa}</div>
            <div><strong>CNPJ:</strong> ${params.cnpj}</div>
            <div><strong>Banco:</strong> ${params.dbType}</div>
            <div><strong>CODEMP:</strong> ${params.codEmp}</div>
          </div>
        ` : ''}
        <a href="/" class="block text-center w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-sm font-semibold transition-all">
          Retornar ao Início
        </a>
      </div>
    </div>
  </body>
  </html>`;

  return res.end(html);
}
