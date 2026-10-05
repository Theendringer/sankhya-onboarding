import type { IncomingMessage, ServerResponse } from 'http';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import { JWT } from 'google-auth-library';
import nodemailer from 'nodemailer';

const google = {
  auth: {
    JWT
  }
};

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

// -----------------------------------------------------------------------------
// 2. AUTENTICAÇÃO COM GOOGLE CALENDAR API (SERVICE ACCOUNT)
// -----------------------------------------------------------------------------
function getGoogleAuth(): JWT {
  let credentials: any = null;

  // 1. Tenta carregar pela variável de ambiente FIREBASE_SERVICE_ACCOUNT (Vercel)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err: any) {
      throw new Error('Falha ao fazer parse da variável FIREBASE_SERVICE_ACCOUNT. Verifique se o JSON é válido: ' + err.message);
    }
  }
  // 1.1 Suporte adicional para FIREBASE_SERVICE_ACCOUNT_KEY (retrocompatibilidade)
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
      credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    } catch (err: any) {
      throw new Error('Falha ao fazer parse da variável FIREBASE_SERVICE_ACCOUNT_KEY. Verifique se o JSON é válido: ' + err.message);
    }
  }
  // 2. Tenta variáveis individuais (fallback)
  else if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    credentials = {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }
  // 3. Fallback para arquivo físico local (localhost)
  else {
    const possiblePaths = [
      path.resolve(process.cwd(), 'firebase-key.json'),
      path.resolve(__dirname, '..', 'firebase-key.json'),
      path.resolve(__dirname, 'firebase-key.json')
    ];

    for (const localKeyPath of possiblePaths) {
      if (fs.existsSync(localKeyPath)) {
        try {
          credentials = JSON.parse(fs.readFileSync(localKeyPath, 'utf8'));
          break;
        } catch {
          // ignora e continua
        }
      }
    }
  }

  if (!credentials || !credentials.client_email || !credentials.private_key) {
    throw new Error('Credenciais de Service Account não encontradas nem na variável FIREBASE_SERVICE_ACCOUNT nem em firebase-key.json');
  }

  // Garante a correção de quebras de linha da chave privada
  const privateKey = credentials.private_key.replace(/\\n/g, '\n');

  return new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly'
    ]
  });
}

// -----------------------------------------------------------------------------
// 3. E-MAIL INTERATIVO AO RESPONSÁVEL / TECH LEAD
// -----------------------------------------------------------------------------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // false para porta 587, true para 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // Senha de App de 16 caracteres do Google
  },
});

async function sendTechLeadMeetingPrompt(meeting: {
  id: string;
  titulo: string;
  descricao?: string;
  fim?: string;
  participantes: Array<{ email: string; displayName?: string }>;
  organizador?: string;
  consultorAgenda?: string;
}, destinatarioEmail?: string) {
  const responsavel = destinatarioEmail || meeting.consultorAgenda || meeting.organizador || process.env.TECH_LEAD_EMAIL || 'gustepereira@gmail.com';
  const fromEmail = process.env.SMTP_FROM || `"Sankhya Hub Onboarding" <${process.env.SMTP_USER || 'contato@dudabloom.com.br'}>`;
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const direcionarUrl = `${baseUrl}/direcionar?id=${encodeURIComponent(meeting.id)}`;

  const fimFormatado = meeting.fim
    ? new Date(meeting.fim).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : 'recentemente';

  const participantesHtml = meeting.participantes.length > 0
    ? `
      <div style="margin: 16px 0; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">
        <span style="font-size: 11px; font-weight: bold; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px;">Participantes Detectados na Reunião:</span>
        <ul style="margin: 8px 0 0 0; padding-left: 20px; font-size: 13px; color: #334155;">
          ${meeting.participantes.map(p => `<li><strong>${p.displayName || p.email.split('@')[0]}</strong> (${p.email})</li>`).join('')}
        </ul>
      </div>
    `
    : '';

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f1f5f9; color: #1e293b; padding: 24px; margin: 0;">
    <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05); overflow: hidden;">
      
      <!-- Topo Executivo -->
      <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #ffffff; padding: 24px 28px; border-bottom: 3px solid #10b981;">
        <div style="display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; background: rgba(16, 185, 129, 0.2); color: #34d399; padding: 4px 10px; border-radius: 9999px; border: 1px solid rgba(16, 185, 129, 0.3); margin-bottom: 12px;">
          Assistente Executivo &bull; Implantação Proativa
        </div>
        <h1 style="margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px;">Reunião Concluída: ${meeting.titulo}</h1>
        <p style="margin: 6px 0 0 0; font-size: 13px; color: #94a3b8;">Finalizada às ${fimFormatado} &bull; Ação de Onboarding Pendente</p>
      </div>

      <!-- Corpo da Mensagem -->
      <div style="padding: 28px; font-size: 14px; line-height: 1.6; color: #334155;">
        <p style="font-size: 15px; margin-top: 0; color: #0f172a;">
          Olá! Notei que a reunião <strong>${meeting.titulo}</strong> acabou de ser concluída na sua agenda.
        </p>

        <p style="color: #475569;">
          Quem é o responsável técnico do cliente para quem devo encaminhar o formulário de parametrização e views do Sankhya?
        </p>

        ${participantesHtml}

        <!-- Botão CTA Principal -->
        <div style="margin: 28px 0; text-align: center;">
          <a href="${direcionarUrl}" style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 12px; font-weight: 700; font-size: 14px; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.35); letter-spacing: 0.2px;">
            👉 Clique aqui para informar o e-mail do cliente e disparar o onboarding
          </a>
        </div>

        <div style="background: #f8fafc; border-left: 3px solid #6366f1; padding: 12px 14px; border-radius: 6px; font-size: 12px; color: #475569;">
          <strong>Dica do Assistente:</strong> Ao clicar no link, você pode apenas digitar em linguagem natural (ex: <em>"Enviar para ti@cliente.com.br com cópia para diretor@empresa.com"</em>) que o modelo de IA interpretará e disparará o fluxo automaticamente.
        </div>

        <div style="margin-top: 24px; padding-top: 18px; border-top: 1px solid #f1f5f9; font-size: 11px; color: #94a3b8; text-align: center;">
          Caso o botão não funcione, acesse diretamente: <br>
          <a href="${direcionarUrl}" style="color: #3b82f6; word-break: break-all;">${direcionarUrl}</a>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await transporter.sendMail({
        from: fromEmail,
        to: responsavel,
        subject: `🔔 [Ação Necessária] Reunião concluída: ${meeting.titulo}`,
        html: htmlContent
      });

      console.log(`[CRON AGENDA] E-mail de notificação enviado com sucesso via Gmail SMTP para ${responsavel}`);
      return true;
    } catch (err: any) {
      console.warn('[CRON AGENDA] Falha ao enviar e-mail ao responsável via Nodemailer/Gmail:', err?.message || err);
      return false;
    }
  } else {
    console.log(`[SIMULAÇÃO E-MAIL TECH LEAD] Notificação de reunião: ${meeting.titulo} -> ${direcionarUrl}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// 4. HANDLER DA ROTA SERVERLESS / CRON (/api/cron-agenda)
// -----------------------------------------------------------------------------
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).send('OK');
  }

  // Validação opcional de segredo de Cron do Vercel
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization']) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Não autorizado' });
    }
  }

  try {
    const db = getFirestore();
    const isSimulate = req.query.simular === 'true' || req.query.simulate === 'true' || req.body?.simular === true;

    // MODO SIMULAÇÃO: Permite testar o pipeline ponta a ponta sem aguardar evento real
    if (isSimulate) {
      const simulatedId = `simulacao-${Date.now()}`;
      const responsavelSimulado = process.env.TECH_LEAD_EMAIL || 'gustepereira@gmail.com';
      const simulatedMeeting = {
        id: simulatedId,
        eventId: simulatedId,
        titulo: req.query.titulo as string || req.body?.titulo || 'Kickoff Implantação - Acqua Brasil & Kenit Hub',
        descricao: 'Alinhamento técnico inicial de implantação do ERP Sankhya integrado ao Kenit Hub.',
        inicio: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        fim: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // Terminou há 20 min
        participantes: [
          { email: responsavelSimulado, displayName: 'Tech Lead' },
          { email: 'ti@acquabrasil.com.br', displayName: 'Roberto Silva (TI Acqua Brasil)' }
        ],
        organizador: responsavelSimulado,
        consultorAgenda: responsavelSimulado,
        status: 'AGUARDANDO_DESTINATARIO',
        simulado: true,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('reunioes_processadas').doc(simulatedId).set(simulatedMeeting);
      const emailSent = await sendTechLeadMeetingPrompt(simulatedMeeting, responsavelSimulado);

      return res.status(200).json({
        success: true,
        modo: 'SIMULACAO',
        mensagem: 'Reunião simulada registrada com sucesso e Tech Lead notificado.',
        reuniao: simulatedMeeting,
        emailEnviado: emailSent
      });
    }

    // MODO PRODUÇÃO: Consulta Google Calendar API para cada consultor
    const auth = getGoogleAuth();
    const tokenResponse = await auth.getAccessToken();
    const accessToken = tokenResponse.token;

    if (!accessToken) {
      throw new Error('Não foi possível obter o access token da Google API.');
    }

    // Múltiplas agendas: suporta GOOGLE_CALENDAR_IDS separado por vírgula, fallback TECH_LEAD_EMAIL
    const rawCalendarIds = process.env.GOOGLE_CALENDAR_IDS || process.env.GOOGLE_CALENDAR_ID || process.env.TECH_LEAD_EMAIL || 'gustepereira@gmail.com';
    const calendarIds = rawCalendarIds
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);

    const targetCalendarIds = calendarIds.length > 0
      ? calendarIds
      : [process.env.TECH_LEAD_EMAIL || 'gustepereira@gmail.com'];

    // Intervalo de busca: reuniões recentes (últimas horas até o presente)
    const now = new Date();
    const windowMinutes = Number(req.query.windowMinutes) || 45;
    const timeMin = new Date(now.getTime() - windowMinutes * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

    const termosRelevantes = /(ongoing|kickoff|implanta[çc][ãa]o|kenit\s*hub)/i;
    const processadas: any[] = [];
    const ignoradas: any[] = [];
    let totalEventosEncontrados = 0;

    for (const calendarEmail of targetCalendarIds) {
      try {
        const calendarUrl = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarEmail)}/events`);
        calendarUrl.searchParams.set('timeMin', timeMin);
        calendarUrl.searchParams.set('timeMax', timeMax);
        calendarUrl.searchParams.set('singleEvents', 'true');
        calendarUrl.searchParams.set('orderBy', 'startTime');

        const calendarRes = await fetch(calendarUrl.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!calendarRes.ok) {
          const errText = await calendarRes.text();
          console.warn(`[CRON AGENDA] Falha ao consultar agenda "${calendarEmail}" (${calendarRes.status}):`, errText);
          ignoradas.push({
            calendarId: calendarEmail,
            motivo: `Erro HTTP ${calendarRes.status} ao acessar agenda (verifique compartilhamento com ${auth.email})`
          });
          continue;
        }

        const calendarData = (await calendarRes.json()) as any;
        const items: any[] = calendarData?.items || [];
        totalEventosEncontrados += items.length;

        for (const event of items) {
          const titulo = event.summary || '';

          // 1. Filtro por título relevante
          if (!termosRelevantes.test(titulo)) {
            ignoradas.push({ id: event.id, titulo, calendarId: calendarEmail, motivo: 'Título não corresponde aos termos de implantação' });
            continue;
          }

          // 2. Filtro por horário de término: finalizada recentemente
          const fimStr = event.end?.dateTime || event.end?.date;
          if (!fimStr) {
            ignoradas.push({ id: event.id, titulo, calendarId: calendarEmail, motivo: 'Sem horário de término definido' });
            continue;
          }

          const fimDate = new Date(fimStr);
          const minutosDesdeFim = (now.getTime() - fimDate.getTime()) / (60 * 1000);

          // Reunião já deve ter terminado
          if (minutosDesdeFim < 0) {
            ignoradas.push({ id: event.id, titulo, calendarId: calendarEmail, motivo: 'Reunião ainda em andamento ou futura' });
            continue;
          }

          // 3. Verifica no Firestore se já foi processada para não duplicar
          const docRef = db.collection('reunioes_processadas').doc(event.id);
          const existingDoc = await docRef.get();
          if (existingDoc.exists) {
            ignoradas.push({ id: event.id, titulo, calendarId: calendarEmail, motivo: 'Já registrada no Firestore' });
            continue;
          }

          // 4. Extração de participantes e dados
          const participantes = (event.attendees || []).map((a: any) => ({
            email: a.email,
            displayName: a.displayName || a.email.split('@')[0],
            responseStatus: a.responseStatus || 'unknown'
          }));

          const meetingData = {
            id: event.id,
            eventId: event.id,
            titulo,
            descricao: event.description || '',
            inicio: event.start?.dateTime || event.start?.date,
            fim: fimStr,
            participantes,
            organizador: event.organizer?.email || '',
            consultorAgenda: calendarEmail,
            responsavel: calendarEmail,
            status: 'AGUARDANDO_DESTINATARIO',
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
          };

          // Gravação no Firestore para não duplicar
          await docRef.set(meetingData);

          // Disparo de notificação para o responsável da agenda
          const emailNotified = await sendTechLeadMeetingPrompt(meetingData, calendarEmail);

          processadas.push({
            id: event.id,
            titulo,
            calendarId: calendarEmail,
            fim: fimStr,
            minutosDesdeFim: Math.round(minutosDesdeFim),
            participantesCount: participantes.length,
            responsavelNotificado: calendarEmail,
            emailEnviado: emailNotified
          });
        }
      } catch (calErr: any) {
        console.warn(`[CRON AGENDA] Erro ao processar agenda "${calendarEmail}":`, calErr?.message || calErr);
        ignoradas.push({
          calendarId: calendarEmail,
          motivo: `Exceção: ${calErr?.message || String(calErr)}`
        });
      }
    }

    return res.status(200).json({
      success: true,
      dataHora: now.toISOString(),
      agendasMonitoradas: targetCalendarIds,
      eventosEncontrados: totalEventosEncontrados,
      processadas,
      ignoradas
    });

  } catch (err: any) {
    console.error('[CRON AGENDA] Erro fatal:', err);
    return res.status(500).json({
      success: false,
      error: err?.message || 'Erro interno ao processar cron agenda'
    });
  }
}
