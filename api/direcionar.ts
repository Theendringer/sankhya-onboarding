import type { IncomingMessage, ServerResponse } from 'http';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenAI } from '@google/genai';
import nodemailer from 'nodemailer';

interface VercelRequest extends IncomingMessage {
  body: any;
  query: { [key: string]: string | string[] };
  headers: { [key: string]: string | undefined };
  method?: string;
}

interface VercelResponse extends ServerResponse {
  status: (code: number) => VercelResponse;
  json: (data: any) => void;
  send: (data: any) => void;
}

// -----------------------------------------------------------------------------
// 1. INICIALIZAÇÃO DO FIRESTORE
// -----------------------------------------------------------------------------
function getFirestore(): admin.firestore.Firestore {
  if (admin.apps.length > 0 && admin.apps[0]) {
    return admin.firestore();
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      return admin.firestore();
    } catch (err) {
      console.warn('Falha ao processar FIREBASE_SERVICE_ACCOUNT_KEY:', err);
    }
  }

  const possiblePaths = [
    path.resolve(process.cwd(), 'firebase-key.json'),
    path.resolve(__dirname, '..', 'firebase-key.json'),
    path.resolve(__dirname, 'firebase-key.json')
  ];

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const serviceAccount = JSON.parse(fileContent);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
        return admin.firestore();
      } catch (err) {
        console.warn(`Erro ao ler ${filePath}:`, err);
      }
    }
  }

  admin.initializeApp();
  return admin.firestore();
}

// -----------------------------------------------------------------------------
// 2. EXTRAÇÃO INTELIGENTE VIA GEMINI AI (COM FALLBACK HEURÍSTICO)
// -----------------------------------------------------------------------------
async function parseInstructionWithAI(options: {
  texto: string;
  meetingTitle?: string;
  meetingDescription?: string;
  attendees?: Array<{ email: string; displayName?: string }>;
}) {
  const { texto, meetingTitle = '', attendees = [] } = options;

  let apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      for (const l of lines) {
        const match = l.match(/^\s*(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*(.*)$/);
        if (match) {
          apiKey = match[1].trim().replace(/^['"]|['"]$/g, '');
          process.env.GEMINI_API_KEY = apiKey;
          break;
        }
      }
    }
  }

  // Tenta extração via Gemini se apiKey estiver disponível
  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

      const prompt = `Você é um assistente executivo sênior do time de Implantação e Onboarding do Sankhya x Hub.
Uma reunião técnica com o cliente foi concluída:
- Título da Reunião: "${meetingTitle}"
- Participantes detectados na agenda: ${JSON.stringify(attendees)}

O Tech Lead enviou o seguinte comando em linguagem natural para direcionar o onboarding técnico do cliente:
"""${texto}"""

SUA MISSÃO:
Extraia com precisão cirúrgica:
1. "emailDestinatario": o e-mail principal do responsável técnico do cliente que deve receber o formulário.
2. "nomeDestinatario": o nome ou tratamento da pessoa ou equipe (ex: "Roberto Silva", "Equipe de TI", etc.).
3. "emailsCopia": array com e-mails adicionais que devem receber em cópia (CC), se mencionados.
4. "nomeEmpresa": o nome da empresa ou cliente (deduza a partir do título da reunião ou da instrução, eliminando termos como "Kickoff", "Ongoing", "Implantação", "Kenit Hub", "x", "-", etc.).

Retorne ESTRITAMENTE um JSON no formato:
{
  "emailDestinatario": "exemplo@cliente.com.br",
  "nomeDestinatario": "Nome ou Cargo",
  "emailsCopia": ["copia1@empresa.com.br"],
  "nomeEmpresa": "Nome da Empresa"
}`;

      const response = await ai.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { responseMimeType: 'application/json', temperature: 0.1 }
      });

      const parsed = JSON.parse(response.text || '{}');
      if (parsed.emailDestinatario) {
        return {
          emailDestinatario: String(parsed.emailDestinatario).trim().toLowerCase(),
          nomeDestinatario: String(parsed.nomeDestinatario || '').trim(),
          emailsCopia: Array.isArray(parsed.emailsCopia) ? parsed.emailsCopia.map((e: string) => String(e).trim().toLowerCase()) : [],
          nomeEmpresa: String(parsed.nomeEmpresa || cleanCompanyName(meetingTitle)).trim(),
          aiParsed: true,
          modelUsed: modelName
        };
      }
    } catch (err: any) {
      console.warn('[DIRECIONAR AI] Fallback para heurística regular:', err?.message || err);
    }
  }

  // FALLBACK HEURÍSTICO / REGEX ROBUSTO
  return parseInstructionHeuristic(texto, meetingTitle);
}

function cleanCompanyName(title: string): string {
  if (!title) return 'Cliente Sankhya';
  return title
    .replace(/(kickoff|ongoing|implanta[çc][ãa]o|reuni[ãa]o|kenit\s*hub|onboarding|sankhya)/gi, '')
    .replace(/[-–—x|:&+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Cliente Sankhya';
}

function parseInstructionHeuristic(texto: string, meetingTitle: string) {
  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const emailsFound = texto.match(emailRegex) || [];

  let emailDestinatario = emailsFound[0] || '';
  let emailsCopia: string[] = [];

  // Se houver mais de um e-mail, o primeiro é o destinatário e os seguintes são cópias
  if (emailsFound.length > 1) {
    emailsCopia = emailsFound.slice(1).map(e => e.trim().toLowerCase());
  }

  // Tenta extrair nome se houver padrão como "para Fulano (email)" ou "para Fulano:"
  let nomeDestinatario = '';
  const nomeMatch = texto.match(/(?:enviar|mandar|direcionar|encaminhar)\s+(?:para|ao|a)\s+([A-ZÀ-Úa-zà-ú\s]+?)(?:\s*\(|\s+com\s+c[oó]pia|\s*[,:]|\s*[a-zA-Z0-9._%+-]+@)/i);
  if (nomeMatch && nomeMatch[1]) {
    const rawNome = nomeMatch[1].trim();
    if (rawNome.length > 1 && !rawNome.includes('@')) {
      nomeDestinatario = rawNome;
    }
  }

  const nomeEmpresa = cleanCompanyName(meetingTitle);

  return {
    emailDestinatario: emailDestinatario.trim().toLowerCase(),
    nomeDestinatario: nomeDestinatario || (emailDestinatario ? emailDestinatario.split('@')[0] : 'Responsável Técnico'),
    emailsCopia,
    nomeEmpresa,
    aiParsed: false,
    modelUsed: 'Heurístico / Expressões Regulares'
  };
}

// -----------------------------------------------------------------------------
// 3. ENVIO DE E-MAIL AO CLIENTE (CONVITE DE ONBOARDING)
// -----------------------------------------------------------------------------
async function sendClientInvitationEmail(options: {
  emailDestinatario: string;
  nomeDestinatario: string;
  emailsCopia: string[];
  nomeEmpresa: string;
  linkOnboarding: string;
}) {
  const { emailDestinatario, nomeDestinatario, emailsCopia, nomeEmpresa, linkOnboarding } = options;
  const fromEmail = process.env.SMTP_FROM || '"Sankhya Hub Onboarding" <no-reply@sankhyahub.com.br>';

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; margin: 0;">
    <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05); overflow: hidden;">
      
      <!-- Topo Institucional -->
      <div style="background: radial-gradient(130% 120% at 50% 0%, #0f172a 0%, #092c4c 50%, #004d84 100%); color: #ffffff; padding: 28px; text-align: center;">
        <div style="display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; background: rgba(52, 211, 153, 0.15); color: #34d399; padding: 4px 12px; border-radius: 9999px; border: 1px solid rgba(52, 211, 153, 0.3); margin-bottom: 12px;">
          Onboarding Técnico &bull; Sankhya x Hub
        </div>
        <h1 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px;">Boas-vindas ao Onboarding de Integração</h1>
        <p style="margin: 6px 0 0 0; font-size: 13px; color: #cbd5e1;">Empresa: <strong>${nomeEmpresa}</strong></p>
      </div>

      <!-- Conteúdo -->
      <div style="padding: 28px; font-size: 14px; line-height: 1.6; color: #334155;">
        <p style="font-size: 15px; margin-top: 0; color: #0f172a;">
          Olá, <strong>${nomeDestinatario || 'Equipe Técnica'}</strong>!
        </p>

        <p>
          Após nossa reunião de alinhamento, estamos dando início à fase de parametrização técnica da sua empresa (<strong>${nomeEmpresa}</strong>) para integração entre o <strong>ERP Sankhya</strong> e o <strong>Hub</strong>.
        </p>

        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 14px 16px; margin: 20px 0;">
          <h4 style="margin: 0 0 6px 0; color: #166534; font-size: 13px; font-weight: 700;">O que você precisa fazer agora:</h4>
          <ol style="margin: 0; padding-left: 20px; font-size: 13px; color: #15803d; line-height: 1.5;">
            <li>Acesse o link exclusivo abaixo;</li>
            <li>Confira os dados da sua empresa (já pré-carregados);</li>
            <li>Indique as TOPs fiscais, estoques e preferências de gravação de pedidos e clientes;</li>
            <li>O Agente de IA validará a conformidade e gerará as 5 views SQL personalizadas.</li>
          </ol>
        </div>

        <!-- Botão CTA Principal -->
        <div style="margin: 32px 0; text-align: center;">
          <a href="${linkOnboarding}" style="display: inline-block; background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: #ffffff; text-decoration: none; padding: 15px 32px; border-radius: 12px; font-weight: 700; font-size: 14px; box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35); letter-spacing: 0.2px;">
            🚀 Acessar Formulário de Parametrização Sankhya
          </a>
        </div>

        <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">
          Qualquer dúvida durante o preenchimento, nossa equipe técnica e o Tech Lead responsável estão à disposição para apoiá-los.
        </p>

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #f1f5f9; font-size: 11px; color: #94a3b8; text-align: center;">
          Link direto: <br>
          <a href="${linkOnboarding}" style="color: #0284c7; word-break: break-all;">${linkOnboarding}</a>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // false para porta 587, true para 465
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS, // Senha de App de 16 caracteres do Google
    },
  });

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await transporter.sendMail({
        from: fromEmail,
        to: emailDestinatario,
        cc: emailsCopia.length > 0 ? emailsCopia : undefined,
        subject: `[Onboarding Sankhya x Hub] Boas-vindas e Formulário de Parametrização - ${nomeEmpresa}`,
        html: htmlContent
      });

      console.log(`[CONVITE CLIENTE] Enviado com sucesso via Gmail SMTP para ${emailDestinatario}`);
      return true;
    } catch (err: any) {
      console.warn('[CONVITE CLIENTE] Falha ao enviar e-mail ao cliente via Nodemailer/Gmail:', err?.message || err);
      return false;
    }
  } else {
    console.log(`[SIMULAÇÃO E-MAIL CLIENTE] Enviado para ${emailDestinatario} -> ${linkOnboarding}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// 4. CONFIRMAÇÃO AO TECH LEAD
// -----------------------------------------------------------------------------
async function sendTechLeadConfirmation(options: {
  emailDestinatario: string;
  nomeDestinatario: string;
  emailsCopia: string[];
  nomeEmpresa: string;
  linkOnboarding: string;
  meetingTitle?: string;
}) {
  const { emailDestinatario, nomeDestinatario, emailsCopia, nomeEmpresa, linkOnboarding, meetingTitle } = options;
  const techLeadEmail = process.env.TECH_LEAD_EMAIL || 'gustepereira@gmail.com';
  const fromEmail = process.env.SMTP_FROM || '"Assistente Sankhya Hub" <no-reply@sankhyahub.com.br>';

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; padding: 24px; margin: 0;">
    <div style="max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05); padding: 24px;">
      <div style="display: flex; align-items: center; margin-bottom: 16px;">
        <span style="display: inline-block; width: 36px; height: 36px; line-height: 36px; text-align: center; border-radius: 50%; background: #dcfce7; color: #15803d; font-size: 18px; font-weight: bold; margin-right: 12px;">✓</span>
        <div>
          <h2 style="margin: 0; font-size: 18px; color: #0f172a;">Convite Enviado com Sucesso!</h2>
          <p style="margin: 2px 0 0 0; font-size: 12px; color: #64748b;">${meetingTitle || 'Onboarding Sankhya x Hub'}</p>
        </div>
      </div>

      <p style="font-size: 14px; color: #334155; line-height: 1.5;">
        Conforme sua instrução, disparei o e-mail de convite com o link personalizado de onboarding para:
      </p>

      <div style="background: #f1f5f9; border-radius: 8px; padding: 14px; font-size: 13px; line-height: 1.6; margin: 16px 0;">
        <div><strong>Destinatário Principal:</strong> ${nomeDestinatario || 'Responsável'} &lt;<code>${emailDestinatario}</code>&gt;</div>
        ${emailsCopia.length > 0 ? `<div><strong>Cópias (CC):</strong> <code>${emailsCopia.join(', ')}</code></div>` : ''}
        <div><strong>Empresa:</strong> ${nomeEmpresa}</div>
        <div><strong>Status:</strong> <span style="color: #0284c7; font-weight: bold;">CONVITE ENVIADO</span></div>
      </div>

      <p style="font-size: 13px; color: #64748b;">
        Assim que o cliente finalizar o preenchimento dos 9 passos do formulário, você receberá a notificação para aprovação e homologação das views SQL.
      </p>

      <div style="margin-top: 18px; font-size: 12px;">
        <a href="${linkOnboarding}" style="color: #0284c7; text-decoration: underline;" target="_blank">
          Visualizar link enviado ao cliente &rarr;
        </a>
      </div>
    </div>
  </body>
  </html>
  `;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // false para porta 587, true para 465
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS, // Senha de App de 16 caracteres do Google
    },
  });

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await transporter.sendMail({
        from: fromEmail,
        to: techLeadEmail,
        subject: `✓ Convite de Onboarding enviado para ${nomeDestinatario || emailDestinatario} (${nomeEmpresa})`,
        html: htmlContent
      });
      console.log(`[CONFIRMACAO TECH LEAD] Enviada com sucesso via Gmail SMTP para ${techLeadEmail}`);
      return true;
    } catch (err: any) {
      console.warn('[CONFIRMACAO TECH LEAD] Falha ao enviar e-mail de confirmação via Nodemailer/Gmail:', err?.message || err);
      return false;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// 5. SERVERLESS FUNCTION HANDLER
// -----------------------------------------------------------------------------
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).send('OK');
  }

  const db = getFirestore();

  // ---------------------------------------------------------------------------
  // GET: Recupera dados da reunião por ID
  // ---------------------------------------------------------------------------
  if (req.method === 'GET') {
    const id = req.query.id as string;
    if (!id) {
      return res.status(400).json({ error: 'Parâmetro "id" é obrigatório.' });
    }

    try {
      const doc = await db.collection('reunioes_processadas').doc(id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Reunião não encontrada no Firestore.' });
      }

      const reuniao = doc.data();
      return res.status(200).json({
        success: true,
        reuniao
      });
    } catch (err: any) {
      console.error('[DIRECIONAR GET] Erro ao buscar reunião:', err);
      return res.status(500).json({ error: err?.message || 'Erro ao consultar reunião.' });
    }
  }

  // ---------------------------------------------------------------------------
  // POST: Interpreta a instrução, extrai dados e dispara o onboarding
  // ---------------------------------------------------------------------------
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { id, texto, emailDestinatario: directEmail, nomeDestinatario: directNome, emailsCopia: directCopias, nomeEmpresa: directEmpresa } = body;

      if (!id && !texto && !directEmail) {
        return res.status(400).json({
          error: 'É necessário informar ao menos o "id" da reunião ou um "texto" / "emailDestinatario".'
        });
      }

      let meetingData: any = null;
      if (id) {
        const doc = await db.collection('reunioes_processadas').doc(id).get();
        if (doc.exists) {
          meetingData = doc.data();
        }
      }

      // Se o usuário passou diretamente os campos estruturados, use-os como prioridade
      let emailDestinatario = directEmail ? String(directEmail).trim().toLowerCase() : '';
      let nomeDestinatario = directNome ? String(directNome).trim() : '';
      let emailsCopia: string[] = Array.isArray(directCopias)
        ? directCopias.map(e => String(e).trim().toLowerCase())
        : (typeof directCopias === 'string' && directCopias.trim() ? directCopias.split(',').map(e => e.trim().toLowerCase()) : []);
      let nomeEmpresa = directEmpresa ? String(directEmpresa).trim() : '';

      let aiResult: any = null;

      // Se faltar o e-mail destinatário e tivermos texto em linguagem natural, use a IA
      if ((!emailDestinatario || !nomeEmpresa) && texto) {
        aiResult = await parseInstructionWithAI({
          texto,
          meetingTitle: meetingData?.titulo || '',
          meetingDescription: meetingData?.descricao || '',
          attendees: meetingData?.participantes || []
        });

        if (!emailDestinatario) {
          emailDestinatario = aiResult.emailDestinatario;
        }
        if (!nomeDestinatario) {
          nomeDestinatario = aiResult.nomeDestinatario;
        }
        if (emailsCopia.length === 0 && aiResult.emailsCopia?.length > 0) {
          emailsCopia = aiResult.emailsCopia;
        }
        if (!nomeEmpresa) {
          nomeEmpresa = aiResult.nomeEmpresa;
        }
      }

      if (!nomeEmpresa && meetingData?.titulo) {
        nomeEmpresa = cleanCompanyName(meetingData.titulo);
      }

      if (!emailDestinatario) {
        return res.status(422).json({
          error: 'Não foi possível identificar o e-mail do destinatário. Por favor, digite o e-mail diretamente ou ajuste o comando em linguagem natural.'
        });
      }

      // Gera o link exclusivo do onboarding com os parâmetros pré-carregados
      const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
      const linkOnboarding = `${baseUrl}/index.html?empresa=${encodeURIComponent(nomeEmpresa)}&email=${encodeURIComponent(emailDestinatario)}&reuniaoId=${encodeURIComponent(id || '')}`;

      // 1. Dispara o e-mail de convite para o cliente
      const clientEmailSent = await sendClientInvitationEmail({
        emailDestinatario,
        nomeDestinatario,
        emailsCopia,
        nomeEmpresa,
        linkOnboarding
      });

      // 2. Atualiza o status no Firestore
      if (id) {
        await db.collection('reunioes_processadas').doc(id).set({
          status: 'CONVITE_ENVIADO',
          emailDestinatario,
          nomeDestinatario,
          emailsCopia,
          nomeEmpresa,
          linkOnboarding,
          enviadoEm: admin.firestore.FieldValue.serverTimestamp(),
          instrucaoOriginal: texto || 'Preenchimento direto'
        }, { merge: true });
      }

      // 3. Notifica o Tech Lead confirmando o envio
      await sendTechLeadConfirmation({
        emailDestinatario,
        nomeDestinatario,
        emailsCopia,
        nomeEmpresa,
        linkOnboarding,
        meetingTitle: meetingData?.titulo
      });

      return res.status(200).json({
        success: true,
        mensagem: `Convite de onboarding enviado com sucesso para ${nomeDestinatario || emailDestinatario} (${nomeEmpresa})`,
        destinatario: emailDestinatario,
        nome: nomeDestinatario,
        copias: emailsCopia,
        nomeEmpresa,
        linkOnboarding,
        emailEnviado: clientEmailSent,
        aiUsed: Boolean(aiResult?.aiParsed),
        modelUsed: aiResult?.modelUsed || 'Direto / Heurístico'
      });

    } catch (err: any) {
      console.error('[DIRECIONAR POST] Erro ao processar:', err);
      return res.status(500).json({
        error: err?.message || 'Erro interno ao processar direcionamento'
      });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
}
