import type { IncomingMessage, ServerResponse } from 'http';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import nodemailer from 'nodemailer';

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

async function sendClientApprovedEmail(params: any, sqlScript: string) {
  const bancoNome = params.dbType === 'SQL_SERVER' ? 'Microsoft SQL Server' : 'Oracle Database';

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 24px;">
    <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); overflow: hidden;">
      
      <!-- Cabeçalho -->
      <div style="background: #0f172a; color: #ffffff; padding: 24px 28px; border-bottom: 3px solid #10b981;">
        <h1 style="margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -0.3px;">Views de Integração Sankhya x Hub</h1>
        <p style="margin: 4px 0 0 0; font-size: 13px; color: #94a3b8;">${params.nomeEmpresa} &bull; Ambiente ${bancoNome}</p>
      </div>

      <!-- Conteúdo -->
      <div style="padding: 28px; font-size: 14px; line-height: 1.6; color: #334155;">
        <p style="margin-top: 0; font-size: 15px;">
          Olá, equipe da <strong>${params.nomeEmpresa}</strong>!
        </p>

        <p>
          Temos uma ótima notícia: as <strong>views personalizadas</strong> para o banco de dados da sua empresa (${bancoNome}) estão prontas para execução.
        </p>

        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin: 20px 0;">
          <h3 style="margin: 0 0 10px 0; font-size: 13px; font-weight: 700; text-transform: uppercase; color: #475569; letter-spacing: 0.5px;">
            Relação das 5 Views (Arquivo anexo):
          </h3>
          <ul style="margin: 0; padding-left: 20px; font-family: monospace; font-size: 13px; color: #0f172a; line-height: 1.8;">
            <li><strong>CH_VIEW_PRODUTO</strong></li>
            <li><strong>CH_VIEW_ESTOQUE</strong></li>
            <li><strong>CH_VIEW_PRECO</strong></li>
            <li><strong>CH_VIEW_PEDIDOFATURADO</strong></li>
            <li><strong>CH_VIEW_PEDIDOFATURADOXML</strong></li>
          </ul>
        </div>

        <div style="background: #f0fdf4; border-left: 4px solid #16a34a; border-radius: 0 8px 8px 0; padding: 16px; margin: 20px 0;">
          <h3 style="margin: 0 0 10px 0; font-size: 13px; font-weight: 700; color: #166534;">
            Instruções para o DBA / time de TI:
          </h3>
          <ol style="margin: 0; padding-left: 20px; font-size: 13px; color: #15803d; line-height: 1.7;">
            <li>Executar o script em anexo (<code>views_integracao_sankhya.sql</code>) com usuário que possua privilégios de leitura nas tabelas de integração (<code>TGFPRO</code>, <code>TGFEST</code>, <code>TGFTAB</code>, <code>TGFCAB</code>, <code>TGFNFE</code>, etc.).</li>
            <li>Garantir permissão de execução na função <code>SNK_GET_PRECO</code>.</li>
            <li><strong>Responder a este e-mail</strong> assim que as views forem criadas para prosseguirmos com os testes de leitura no Hub.</li>
          </ol>
        </div>

        <p style="font-size: 13px; color: #64748b; margin-bottom: 0;">
          Qualquer dúvida técnica na execução do script, nossa equipe de integração está à disposição para apoiá-los.
        </p>
      </div>
    </div>
  </body>
  </html>`;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // false para porta 587, true para 465
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS, // Senha de App de 16 caracteres do Google
    },
  });

  const fromEmail = process.env.SMTP_FROM || `"Sankhya Hub Onboarding" <${process.env.SMTP_USER || 'contato@dudabloom.com.br'}>`;

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await transporter.sendMail({
        from: fromEmail,
        to: params.emailTecnico,
        subject: `Views de Integração Sankhya x Hub - ${params.nomeEmpresa}`,
        html: htmlContent,
        attachments: [
          {
            filename: 'views_integracao_sankhya.sql',
            content: sqlScript,
            contentType: 'application/sql'
          }
        ]
      });
      console.log(`[MAILER] E-mail de views enviado com sucesso via Gmail SMTP para ${params.emailTecnico}`);
    } catch (err: any) {
      console.error('[MAILER] Erro ao enviar e-mail ao cliente via Nodemailer/Gmail:', err?.message || err);
    }
  } else {
    console.log(`[SIMULAÇÃO E-MAIL CLIENTE APROVADO] Para: ${params.emailTecnico}`);
  }
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

    if (data?.status === 'APROVADO') {
      return renderHtmlResponse(
        res,
        200,
        'Já Aprovado',
        `Esta solicitação para <strong>${data?.params?.nomeEmpresa}</strong> já foi aprovada anteriormente em ${new Date(data?.aprovadoEm).toLocaleString('pt-BR')}.`,
        'success',
        data?.params
      );
    }

    const now = new Date().toISOString();
    await docRef.update({
      status: 'APROVADO',
      aprovadoEm: now,
      updatedAt: now
    });

    await sendClientApprovedEmail(data.params, data.sqlScript);

    return renderHtmlResponse(
      res,
      200,
      'Implantação Aprovada com Sucesso!',
      `A solicitação para <strong>${data.params.nomeEmpresa}</strong> foi aprovada. O script SQL (5 views para ${data.params.dbType}) foi despachado para o e-mail técnico <strong>${data.params.emailTecnico}</strong> com o guia de execução no Sankhya.`,
      'success',
      data.params
    );
  } catch (error: any) {
    console.error('[ERRO api/aprovar]:', error);
    return renderHtmlResponse(res, 500, 'Erro no Processamento', `Erro interno: ${error?.message || String(error)}`, 'error');
  }
}

function renderHtmlResponse(res: VercelResponse, statusCode: number, title: string, message: string, type: 'success' | 'error', params?: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const isSuccess = type === 'success';

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
      <div class="${isSuccess ? 'bg-emerald-600' : 'bg-rose-600'} p-6 text-white text-center">
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
