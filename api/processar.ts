import type { IncomingMessage, ServerResponse } from 'http';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
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

export interface DeParaEntry {
  confirmado?: boolean;
  customizado?: string;
}

export interface DeParaAuditRow {
  hub: string;
  tabela: string;
  padrao: string;
  aplicado: string;
  customizado: boolean;
  confirmado: boolean;
}

// -----------------------------------------------------------------------------
// MODELOS DE DADOS PARA GRAVAÇÃO DE CLIENTE E PEDIDO (HUB X SANKHYA)
// -----------------------------------------------------------------------------
export interface ParametrosGravacaoCliente {
  criarContatoCliente: 'Sim' | 'Não' | string;
  grupoIcms: string;
  tabelaPrecoCliente: string;
  classificacaoIcms: string;
  retemIss: 'Não' | 'Sim' | string;
  codTipParc: string;
  identInscEstad: string;
}

export interface ParametrosGravacaoPedido {
  codEmpFaturamento: string | number;
  codTipOper: string;
  serieNota: string;
  tipFrete: string;
  regraStatusPedido: 'Liberado' | 'Em aberto' | string;
  regraDesconto: 'Desconto' | 'Valor' | string;
  regraJuros: 'Juros' | 'Valor' | string;
  regraIpi: 'Não Considera' | 'Considera' | string;
}

export interface ParametrosCliente {
  cliente: ParametrosGravacaoCliente;
  pedido: ParametrosGravacaoPedido;
}

export interface DeParaCanal {
  canal: string;
  codVendedor: string;
  codNatureza: string;
  codTipVenda: string;
}

export interface DeParaTransportadora {
  canal: string;
  codTransportadora: string;
  modalidade: string;
  regraFrete: 'Não Considera' | 'Considera' | string;
}

export interface OnboardingParams {
  nomeEmpresa: string;
  cnpj: string;
  emailTecnico: string;
  dbType: 'ORACLE' | 'SQL_SERVER';
  codEmp: string | number;
  // Estoque
  codEmpEstoque: string | number;
  locaisEstoque: string;
  regraReserva?: string;
  // Preço
  codEmpPreco: string | number;
  localPreco: string | number;
  tabelasPreco: string;
  // Bloco A: Gravação de Cliente (TGFPAR)
  gravacaoCliente: ParametrosGravacaoCliente;
  // Bloco B: Gravação de Pedido (TGFCAB / TGFITE)
  gravacaoPedido: ParametrosGravacaoPedido;
  // De/Para de Vendedores e Canais (Marketplaces)
  deParaCanais?: DeParaCanal[];
  // De/Para de Transportadoras por Marketplace
  deParaTransportadoras?: DeParaTransportadora[];
  // Faturamento e dados fiscais (legado / compatibilidade)
  codEmpFaturamento: string | number;
  dadosFiscais: {
    codTipOper: string;
    serieNota: string;
    regraReserva?: string;
  };
  // Conectividade e Acesso ao Sankhya MGE & SankhyaOm
  linkMge?: string;
  usuarioSankhya?: string;
  senhaSankhya?: string;
  tokenSankhyaOm?: string;
  // Produtos
  campoFlag: string;
  campoEan: string;
  campoMarca: string;
  adIntegracaoCode?: string;
  dePara?: Record<string, DeParaEntry>;
}

// -----------------------------------------------------------------------------
// 1. CARREGAMENTO DOS TEMPLATES DE VIEW SANKHYA
// -----------------------------------------------------------------------------
function loadTemplate(dbType: 'ORACLE' | 'SQL_SERVER'): string {
  const filename = dbType === 'ORACLE' ? 'oracle_template.sql' : 'sqlserver_template.sql';
  const possiblePaths = [
    path.resolve(process.cwd(), 'templates', filename),
    path.resolve(__dirname, '..', 'templates', filename),
    path.resolve(__dirname, 'templates', filename)
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8');
    }
  }

  throw new Error(`Arquivo de template ${filename} não encontrado no diretório templates/.`);
}

// -----------------------------------------------------------------------------
// 2. VALIDADOR DE CONFORMIDADE DETERMINÍSTICO (PREENCHIMENTO ESTRITO COM DE/PARA)
// -----------------------------------------------------------------------------
function fillTemplateConformity(template: string, params: OnboardingParams): { sqlScript: string; auditRows: DeParaAuditRow[] } {
  // Parâmetros de Estoque
  const codEmpEstoque = String(params.codEmpEstoque || params.codEmp || '1')
    .split(',')
    .map(c => c.trim())
    .filter(c => c.length > 0 && !isNaN(Number(c)))
    .join(', ') || '1';

  const locaisEstoque = params.locaisEstoque
    .split(',')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !isNaN(Number(l)))
    .join(', ') || '0';

  const regraReserva = params.dadosFiscais?.regraReserva || params.regraReserva || 'DEDUZIR';
  const exprEstoqueSaldo = regraReserva === 'IGNORAR' ? 'e.estoque' : 'e.estoque - e.reservado';

  // Parâmetros de Preço
  const codEmpPreco = String(params.codEmpPreco || params.codEmp || '1').trim().split(',')[0]?.trim() || '1';
  const localPreco = String(params.localPreco !== undefined && params.localPreco !== null && params.localPreco !== '' ? params.localPreco : '0').trim();
  const codTab = String(params.tabelasPreco || '1').split(',')[0]?.trim() || '1';

  // Bloco A: Parâmetros para Gravação de Cliente (TGFPAR)
  const cli = params.gravacaoCliente || {};
  const criarContato = cli.criarContatoCliente || 'Sim';
  const grupoIcms = cli.grupoIcms || '1';
  const tabPrecoCli = cli.tabelaPrecoCliente || codTab || '1';
  const classIcms = cli.classificacaoIcms || '1';
  const retemIss = cli.retemIss || 'Não';
  const codTipParc = cli.codTipParc || '1';
  const identInscEstad = cli.identInscEstad || '9';

  // Bloco B: Parâmetros para Gravação de Pedido (TGFCAB / TGFITE)
  const ped = params.gravacaoPedido || {};
  const topPedido = ped.codTipOper || params.dadosFiscais?.codTipOper || '1100';
  const serieNotaPedido = (ped.serieNota || params.dadosFiscais?.serieNota || '1').trim().replace(/'/g, "''");
  const tipFrete = ped.tipFrete || 'C';
  const statusPedido = ped.regraStatusPedido || 'Liberado';
  const regraDesconto = ped.regraDesconto || 'Desconto';
  const regraJuros = ped.regraJuros || 'Juros';
  const regraIpi = ped.regraIpi || 'Não Considera';

  // Parâmetros de Faturamento / Empresa
  const codEmpFaturamento = String(ped.codEmpFaturamento || params.codEmpFaturamento || params.codEmp || '1')
    .split(',')
    .map(c => c.trim())
    .filter(c => c.length > 0 && !isNaN(Number(c)))
    .join(', ') || '1';

  const dp = params.dePara || {};

  function resolveField(hubKey: string, defaultExpr: string): { expr: string; isCustom: boolean; confirmed: boolean } {
    const entry = dp[hubKey];
    const rawCustom = entry?.customizado?.trim();
    const confirmed = Boolean(entry?.confirmado);
    if (rawCustom && rawCustom.length > 0) {
      let custom = rawCustom;
      if (hubKey === 'FLAG DE INTEGRAÇÃO') {
        custom = custom.replace(/^p\./i, '');
      } else if (/^[A-Za-z0-9_]+$/.test(custom)) {
        if (hubKey === 'CODIGOUNIVERSAL') {
          custom = custom.toUpperCase().startsWith('AD_') ? `p.${custom}` : `C.${custom}`;
        } else {
          custom = `p.${custom}`;
        }
      }
      return { expr: custom, isCustom: true, confirmed };
    }
    return { expr: defaultExpr, isCustom: false, confirmed };
  }

  // Resolução dos 19 campos mapeáveis de produtos
  const codigo = resolveField('CODIGO', 'p.codprod');
  const codigoErp = resolveField('CODIGOERP', 'p.codprod');
  const nome = resolveField('NOME', 'p.descrprod');
  const descricao = resolveField('DESCRICAO', 'p.AD_CARACTECOM');
  const categoria = resolveField('CATEGORIA', 'p.codgrupoprod');
  const fabricante = resolveField('FABRICANTE', 'p.FABRICANTE');
  const marca = resolveField('MARCA', params.campoMarca || 'COALESCE(P.CODMARCA, M.CODIGO)');
  const modelo = resolveField('MODELO', 'p.referencia');
  const status = resolveField('STATUS', "CASE WHEN p.ATIVO = 'S' THEN 'ativo' ELSE 'inativo' END");
  const garantia = resolveField('GARANTIA', 'p.AD_GARANTIA');
  const ean = resolveField('CODIGOUNIVERSAL', params.campoEan || 'C.CODBARRA');
  const origem = resolveField('ORIGEM', 'p.origprod');
  const ncm = resolveField('NCM', 'p.ncm');
  const unidade = resolveField('UNIDADEMEDIDA', 'p.unidade');
  const altura = resolveField('ALTURA', "CASE WHEN p.unidade = 'MM' THEN p.altura / 10 WHEN p.unidade = 'M' THEN p.altura * 100 ELSE p.altura END");
  const largura = resolveField('LARGURA', "CASE WHEN p.unidade = 'MM' THEN p.largura / 10 WHEN p.unidade = 'M' THEN p.largura * 100 ELSE p.largura END");
  const profundidade = resolveField('PROFUNDIDADE', "CASE WHEN p.unidade = 'MM' THEN p.espessura / 10 WHEN p.unidade = 'M' THEN p.espessura * 100 ELSE p.espessura END");
  const peso = resolveField('PESO', 'p.pesobruto');
  const flag = resolveField('FLAG DE INTEGRAÇÃO', params.campoFlag || params.adIntegracaoCode || 'AD_ECOMMERCE');

  const auditRows: DeParaAuditRow[] = [
    { hub: 'CODIGO', tabela: 'TGFPRO', padrao: 'codprod', aplicado: codigo.expr, customizado: codigo.isCustom, confirmado: codigo.confirmed },
    { hub: 'CODIGOERP', tabela: 'TGFPRO', padrao: 'codprod', aplicado: codigoErp.expr, customizado: codigoErp.isCustom, confirmado: codigoErp.confirmed },
    { hub: 'NOME', tabela: 'TGFPRO', padrao: 'descrprod', aplicado: nome.expr, customizado: nome.isCustom, confirmado: nome.confirmed },
    { hub: 'DESCRICAO', tabela: 'TGFPRO', padrao: 'AD_CARACTECOM', aplicado: descricao.expr, customizado: descricao.isCustom, confirmado: descricao.confirmed },
    { hub: 'CATEGORIA', tabela: 'TGFPRO', padrao: 'codgrupoprod', aplicado: categoria.expr, customizado: categoria.isCustom, confirmado: categoria.confirmed },
    { hub: 'FABRICANTE', tabela: 'TGFPRO', padrao: 'FABRICANTE', aplicado: fabricante.expr, customizado: fabricante.isCustom, confirmado: fabricante.confirmed },
    { hub: 'MARCA', tabela: 'TGFPRO / TGFMAR', padrao: 'CODMARCA (TGFMAR.CODIGO)', aplicado: marca.expr, customizado: marca.isCustom, confirmado: marca.confirmed },
    { hub: 'MODELO', tabela: 'TGFPRO', padrao: 'referencia', aplicado: modelo.expr, customizado: modelo.isCustom, confirmado: modelo.confirmed },
    { hub: 'STATUS', tabela: 'TGFPRO', padrao: 'ATIVO', aplicado: status.expr, customizado: status.isCustom, confirmado: status.confirmed },
    { hub: 'GARANTIA', tabela: 'TGFPRO', padrao: 'AD_GARANTIA', aplicado: garantia.expr, customizado: garantia.isCustom, confirmado: garantia.confirmed },
    { hub: 'CODIGOUNIVERSAL', tabela: 'TGFBAR', padrao: 'CODBARRA', aplicado: ean.expr, customizado: ean.isCustom, confirmado: ean.confirmed },
    { hub: 'ORIGEM', tabela: 'TGFPRO', padrao: 'origprod', aplicado: origem.expr, customizado: origem.isCustom, confirmado: origem.confirmed },
    { hub: 'NCM', tabela: 'TGFPRO', padrao: 'ncm', aplicado: ncm.expr, customizado: ncm.isCustom, confirmado: ncm.confirmed },
    { hub: 'UNIDADEMEDIDA', tabela: 'TGFPRO', padrao: 'unidade', aplicado: unidade.expr, customizado: unidade.isCustom, confirmado: unidade.confirmed },
    { hub: 'ALTURA', tabela: 'TGFPRO', padrao: 'altura', aplicado: altura.expr, customizado: altura.isCustom, confirmado: altura.confirmed },
    { hub: 'LARGURA', tabela: 'TGFPRO', padrao: 'largura', aplicado: largura.expr, customizado: largura.isCustom, confirmado: largura.confirmed },
    { hub: 'PROFUNDIDADE', tabela: 'TGFPRO', padrao: 'espessura', aplicado: profundidade.expr, customizado: profundidade.isCustom, confirmado: profundidade.confirmed },
    { hub: 'PESO', tabela: 'TGFPRO', padrao: 'pesobruto', aplicado: peso.expr, customizado: peso.isCustom, confirmado: peso.confirmed },
    { hub: 'FLAG DE INTEGRAÇÃO', tabela: 'TGFPRO', padrao: 'AD_ECOMMERCE', aplicado: flag.expr, customizado: flag.isCustom, confirmado: flag.confirmed }
  ];

  const sqlScript = template
    .replace(/\{\{NOME_EMPRESA\}\}/g, params.nomeEmpresa)
    .replace(/\{\{CGC\}\}/g, params.cnpj)
    .replace(/\{\{CODEMP_ESTOQUE\}\}/g, codEmpEstoque)
    .replace(/\{\{LOCAIS_ESTOQUE\}\}/g, locaisEstoque)
    .replace(/\{\{CODEMP_PRECO\}\}/g, codEmpPreco)
    .replace(/\{\{LOCAL_PRECO\}\}/g, localPreco)
    .replace(/\{\{TABELA_PRECO\}\}/g, codTab)
    .replace(/\{\{CODEMP_FATURAMENTO\}\}/g, codEmpFaturamento)
    .replace(/\{\{EXPR_ESTOQUE_SALDO\}\}/g, exprEstoqueSaldo)
    .replace(/\{\{CODEMP\}\}/g, codEmpEstoque) // Fallback
    // Placeholders Bloco A (TGFPAR)
    .replace(/\{\{CRIAR_CONTATO\}\}/g, criarContato)
    .replace(/\{\{GRUPO_ICMS\}\}/g, grupoIcms)
    .replace(/\{\{TABELA_PRECO_CLIENTE\}\}/g, tabPrecoCli)
    .replace(/\{\{CLASSIFICACAO_ICMS\}\}/g, classIcms)
    .replace(/\{\{RETEM_ISS\}\}/g, retemIss)
    .replace(/\{\{CODTIPPARC\}\}/g, codTipParc)
    .replace(/\{\{IDENTINSCESTAD\}\}/g, identInscEstad)
    // Placeholders Bloco B (TGFCAB / TGFITE)
    .replace(/\{\{CODTIPOPER\}\}/g, topPedido)
    .replace(/\{\{SERIENOTA\}\}/g, serieNotaPedido)
    .replace(/\{\{TIPFRETE\}\}/g, tipFrete)
    .replace(/\{\{REGRA_STATUS_PEDIDO\}\}/g, statusPedido)
    .replace(/\{\{REGRA_DESCONTO\}\}/g, regraDesconto)
    .replace(/\{\{REGRA_JUROS\}\}/g, regraJuros)
    .replace(/\{\{REGRA_IPI\}\}/g, regraIpi)
    // Placeholders Produtos
    .replace(/\{\{CAMPO_CODIGO\}\}/g, codigo.expr)
    .replace(/\{\{CAMPO_CODIGOERP\}\}/g, codigoErp.expr)
    .replace(/\{\{CAMPO_NOME\}\}/g, nome.expr)
    .replace(/\{\{CAMPO_DESCRICAO\}\}/g, descricao.expr)
    .replace(/\{\{CAMPO_CATEGORIA\}\}/g, categoria.expr)
    .replace(/\{\{CAMPO_FABRICANTE\}\}/g, fabricante.expr)
    .replace(/\{\{CAMPO_MARCA\}\}/g, marca.expr)
    .replace(/\{\{CAMPO_MODELO\}\}/g, modelo.expr)
    .replace(/\{\{CAMPO_STATUS\}\}/g, status.expr)
    .replace(/\{\{CAMPO_GARANTIA\}\}/g, garantia.expr)
    .replace(/\{\{CAMPO_EAN\}\}/g, ean.expr)
    .replace(/\{\{CAMPO_ORIGEM\}\}/g, origem.expr)
    .replace(/\{\{CAMPO_NCM\}\}/g, ncm.expr)
    .replace(/\{\{CAMPO_UNIDADEMEDIDA\}\}/g, unidade.expr)
    .replace(/\{\{CAMPO_ALTURA\}\}/g, altura.expr)
    .replace(/\{\{CAMPO_LARGURA\}\}/g, largura.expr)
    .replace(/\{\{CAMPO_PROFUNDIDADE\}\}/g, profundidade.expr)
    .replace(/\{\{CAMPO_PESO\}\}/g, peso.expr)
    .replace(/\{\{CAMPO_FLAG\}\}/g, flag.expr);

  // Formatação do resumo de Canais para comentário no script SQL
  let canaisComment = '-- (Nenhum canal adicional configurado)';
  if (params.deParaCanais && params.deParaCanais.length > 0) {
    canaisComment = params.deParaCanais.map(c => 
      `-- * CANAL: ${c.canal.padEnd(22)} | VENDEDOR: ${(c.codVendedor || '-').padEnd(8)} | NATUREZA: ${(c.codNatureza || '-').padEnd(10)} | TIPO VENDA: ${c.codTipVenda || '-'}`
    ).join('\n');
  }

  // Formatação do resumo de Transportadoras para comentário no script SQL
  let transpComment = '-- (Nenhuma transportadora adicional configurada)';
  if (params.deParaTransportadoras && params.deParaTransportadoras.length > 0) {
    transpComment = params.deParaTransportadoras.map(t => 
      `-- * CANAL: ${t.canal.padEnd(22)} | TRANSPORTADORA: ${(t.codTransportadora || '-').padEnd(8)} | MODALIDADE: ${(t.modalidade || '-').padEnd(20)} | REGRA FRETE: ${t.regraFrete || 'Não Considera'}`
    ).join('\n');
  }

  const finalSql = sqlScript
    .replace(/\{\{DEPARA_CANAIS\}\}/g, canaisComment)
    .replace(/\{\{DEPARA_TRANSPORTADORAS\}\}/g, transpComment);

  return { sqlScript: finalSql, auditRows };
}

function generateDeParaMarkdownTable(rows: DeParaAuditRow[]): string {
  let md = '| Campo Hub / Destino | Tabela Sankhya | Campo Padrão | Expressão Aplicada na View | Tipo | Confirmação |\n';
  md += '| :--- | :--- | :--- | :--- | :--- | :--- |\n';
  for (const r of rows) {
    const tipo = r.customizado ? '**CUSTOMIZADO**' : 'Padrão';
    const status = r.confirmado ? '✓ Confirmado' : 'Padrão Aceito';
    md += `| \`${r.hub}\` | **${r.tabela}** | \`${r.padrao}\` | \`${r.aplicado}\` | ${tipo} | ${status} |\n`;
  }
  return md;
}

function generateCanaisMarkdownTable(canais?: DeParaCanal[]): string {
  if (!canais || canais.length === 0) {
    return '| Canal / Marketplace | Cód. Vendedor (tgfven) | Cód. Natureza (CODNAT) | Tipo de Venda (CODTIPVENDA) |\n| :--- | :--- | :--- | :--- |\n| *Nenhum canal configurado* | - | - | - |\n';
  }
  let md = '| Canal / Marketplace | Cód. Vendedor (tgfven) | Cód. Natureza (CODNAT) | Tipo de Venda (CODTIPVENDA) |\n';
  md += '| :--- | :--- | :--- | :--- |\n';
  for (const c of canais) {
    md += `| **${c.canal}** | \`${c.codVendedor || '-'}\` | \`${c.codNatureza || '-'}\` | \`${c.codTipVenda || '-'}\` |\n`;
  }
  return md;
}

function generateTransportadorasMarkdownTable(transp?: DeParaTransportadora[]): string {
  if (!transp || transp.length === 0) {
    return '| Canal / Marketplace | Cód. Transportadora (tgfpar) | Modalidade de Entrega | Regra de Frete |\n| :--- | :--- | :--- | :--- |\n| *Nenhuma transportadora configurada* | - | - | - |\n';
  }
  let md = '| Canal / Marketplace | Cód. Transportadora (tgfpar) | Modalidade de Entrega | Regra de Frete |\n';
  md += '| :--- | :--- | :--- | :--- |\n';
  for (const t of transp) {
    md += `| **${t.canal}** | \`${t.codTransportadora || '-'}\` | \`${t.modalidade || '-'}\` | **${t.regraFrete || 'Não Considera'}** |\n`;
  }
  return md;
}

// -----------------------------------------------------------------------------
// 3. AGENTE DE IA (VALIDADOR DE CONFORMIDADE COM GEMINI API)
// -----------------------------------------------------------------------------
async function runComplianceAIAgent(rawTemplate: string, params: OnboardingParams) {
  const { sqlScript: deterministicSql, auditRows } = fillTemplateConformity(rawTemplate, params);
  const auditTableMd = generateDeParaMarkdownTable(auditRows);

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

  const cli = params.gravacaoCliente || {};
  const ped = params.gravacaoPedido || {};
  const canaisTableMd = generateCanaisMarkdownTable(params.deParaCanais);
  const transpTableMd = generateTransportadorasMarkdownTable(params.deParaTransportadoras);

  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

      const prompt = `Você é o Validador de Conformidade de Banco de Dados e Engenheiro Especialista em ERP Sankhya x Hub.

SEU OBJETIVO:
Você recebeu o template oficial com as 5 views do Sankhya no dialeto ${params.dbType} e os parâmetros completos de integração de Catálogo, Estoque, Preços, Gravação de Clientes e Gravação de Pedidos.
Mantenha 100% dos nomes e aliases das colunas do template rigorosamente intactos (AS CODIGO, AS CODIGOERP, AS NOME, AS DESCRICAO, etc.).

PARAMETRIZAÇÃO TÉCNICA:
- Empresa: ${params.nomeEmpresa} (CNPJ: ${params.cnpj}) | Banco: ${params.dbType}
- Estoque: Empresa(s) = ${params.codEmpEstoque}, Locais = ${params.locaisEstoque}, Regra Reserva = ${params.regraReserva || 'DEDUZIR'}
- Preços: Empresa = ${params.codEmpPreco}, Local = ${params.localPreco}, Tabela = ${params.tabelasPreco}
- Gravação de Cliente (TGFPAR): Criar Contato=${cli.criarContatoCliente}, Grupo ICMS=${cli.grupoIcms}, Tab Preço=${cli.tabelaPrecoCliente}, Classif ICMS=${cli.classificacaoIcms}, Retém ISS=${cli.retemIss}, Tipo Parc=${cli.codTipParc}, IE=${cli.identInscEstad}
- Gravação de Pedido (TGFCAB/TGFITE): TOP=${ped.codTipOper}, Série=${ped.serieNota}, Frete=${ped.tipFrete}, Status=${ped.regraStatusPedido}, Desconto=${ped.regraDesconto}, Juros=${ped.regraJuros}, IPI=${ped.regraIpi}
- De/Para de Canais e Marketplaces: ${params.deParaCanais?.length || 0} canal(is) configurado(s)
- De/Para de Transportadoras: ${params.deParaTransportadoras?.length || 0} transportadora(s) configurada(s)

TABELA DE/PARA DE PRODUTOS:
${auditTableMd}

TEMPLATE COM PLACEHOLDERS PREENCHIDOS:
\`\`\`sql
${deterministicSql}
\`\`\`

Retorne estritamente um JSON:
{
  "sqlScript": "DDL SQL completo das 5 views mantendo os aliases e expressões validadas",
  "technicalReport": "Relatório Técnico em markdown contendo: 1. Diagnóstico do Ambiente (${params.dbType}), 2. Configurações por Módulo (Produtos, Estoque, Preços, Gravação de Clientes, Gravação de Pedidos, Canais/Marketplaces, Transportadoras), 3. Tabela de Auditoria do De/Para, 4. Racional das 5 Views, 5. Recomendações de Índices"
}`;

      const response = await ai.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { responseMimeType: 'application/json', temperature: 0.1 }
      });

      const parsed = JSON.parse(response.text || '{}');
      if (parsed.sqlScript && parsed.technicalReport) {
        return {
          sqlScript: parsed.sqlScript,
          technicalReport: parsed.technicalReport,
          generatedByAI: true,
          modelUsed: modelName,
          auditRows
        };
      }
    } catch (err: any) {
      console.warn('[AI AGENT] Fallback ativado:', err?.message || err);
    }
  }

  const technicalReport = `
# Relatório Técnico de Implantação e Conformidade: Sankhya x Hub

**Empresa:** ${params.nomeEmpresa} (CNPJ: ${params.cnpj})  
**Banco de Dados:** ${params.dbType}  
**E-mail Técnico:** ${params.emailTecnico}  

---

## 1. Configurações por Módulo

### A. Catálogo de Produtos (TGFPRO & TGFBAR)
- **Filtro de Habilitação (FLAG):** \`p.${params.campoFlag} = 'S'\`
- **Validação de Campos:** 19 atributos validados pelo cliente (detalhes na tabela abaixo)

### B. Estoque e Saldos Físicos (TGFEST & TSIEMP)
- **Empresa(s) de Estoque (CODEMP):** \`${params.codEmpEstoque}\`
- **Locais Físicos Considerados (CODLOCAL):** \`${params.locaisEstoque}\`
- **Regra de Reserva:** \`${params.regraReserva === 'IGNORAR' ? 'Estoque Bruto - SUM(ESTOQUE)' : 'Deduzir Reservas - SUM(ESTOQUE - RESERVADO)'}\`

### C. Preços e Políticas Comerciais (SNK_PRECO & TGFTAB)
- **Empresa de Preço (CODEMP):** \`${params.codEmpPreco}\`
- **Local de Referência de Preço (CODLOCAL):** \`${params.localPreco}\`
- **Tabela de Preço no Sankhya (CODTAB):** \`${params.tabelasPreco}\`

### D. Gravação de Cliente no Sankhya (TGFPAR)
| Parâmetro | Valor Configurado | Descrição |
| :--- | :--- | :--- |
| Criar Contato do Cliente | **${cli.criarContatoCliente || 'Sim'}** | Cadastro automático de contato pelo Hub |
| Grupo de ICMS | \`${cli.grupoIcms || '1'}\` | Código do grupo de ICMS padrão atribuído |
| Tabela de Preço do Cliente | \`${cli.tabelaPrecoCliente || params.tabelasPreco || '1'}\` | Código da tabela de preço no cadastro (CODTAB) |
| Classificação de ICMS | \`${cli.classificacaoIcms || '1'}\` | Classificação de ICMS para gravação do parceiro |
| Retém ISS | **${cli.retemIss || 'Não'}** | Indicador padrão de retenção de ISS |
| Perfil Principal (CODTIPPARC) | \`${cli.codTipParc || '1'}\` | Código do tipo de parceiro no Sankhya |
| Inscrição Estadual (IDENTINSCESTAD) | \`${cli.identInscEstad || '9'}\` | Indicador de IE (Contribuinte / Não Contribuinte / Isento) |

### E. Gravação de Pedido de Venda (TGFCAB / TGFITE)
| Parâmetro | Valor Configurado | Descrição |
| :--- | :--- | :--- |
| Empresa do Pedido (CODEMP) | \`${ped.codEmpFaturamento || params.codEmpFaturamento || '1'}\` | Filial emissora e de faturamento do pedido |
| Operação Fiscal (CODTIPOPER) | \`${ped.codTipOper || params.dadosFiscais?.codTipOper || '1100'}\` | Tipo de Operação (TOP) para entrada do pedido |
| Série da Nota (SERIENOTA) | \`${ped.serieNota || params.dadosFiscais?.serieNota || '1'}\` | Série da nota/pedido utilizada |
| Tipo de Frete (TIPFRETE) | \`${ped.tipFrete || 'C'}\` | Código de frete gravado no cabeçalho do pedido |
| Regra de Status | **${ped.regraStatusPedido || 'Liberado'}** | Define se reserva estoque imediatamente ou entra em aberto |
| Regra de Desconto | **${ped.regraDesconto || 'Desconto'}** | Tratamento de descontos (campo próprio VLRDESC vs unitário) |
| Regra de Juros | **${ped.regraJuros || 'Juros'}** | Tratamento de acréscimos/juros (campo próprio vs unitário) |
| Regra de IPI | **${ped.regraIpi || 'Não Considera'}** | Tratamento de IPI no preço unitário dos itens |

### F. De/Para de Vendedores e Canais (Marketplaces)
${canaisTableMd}

### G. De/Para de Transportadoras por Marketplace (TGFPAR)
${transpTableMd}

---

## 2. Auditoria e Validação Técnica do De/Para de Produtos
${auditTableMd}

---

## 3. Racional das 5 Views
1. \`CH_VIEW_PRODUTO\`: Catálogo de produtos com os 19 campos mapeados e validados pelo cliente a partir de \`TGFPRO\`, \`TGFBAR\` e \`TGFMAR\`.
2. \`CH_VIEW_ESTOQUE\`: Saldos disponíveis consolidados na(s) filial(is) ${params.codEmpEstoque} e locais (${params.locaisEstoque}) a partir de \`TGFEST\` e \`TSIEMP\`.
3. \`CH_VIEW_PRECO\`: Preços extraídos pela function oficial na tabela ${params.tabelasPreco}, empresa ${params.codEmpPreco} e local ${params.localPreco}.
4. \`CH_VIEW_PEDIDOFATURADO\`: Pedidos faturados aprovados (\`STATUSNFE = 'A'\`), CFOP principal e rastreio de pedido de origem (\`TGFVAR\`).
5. \`CH_VIEW_PEDIDOFATURADOXML\`: Chave NFe e XML de distribuição particionado em 10 blocos de 4.000 caracteres (\`TGFNFE\`) para integração contínua.

---

## 4. Recomendações de Performance (Índices)
- \`CREATE INDEX IX_TGFEST_HUB ON TGFEST(CODEMP, CODLOCAL, CODPROD);\`
- \`CREATE INDEX IX_TGFCAB_HUB ON TGFCAB(CODEMP, NUMNOTA, STATUSNFE);\`
- \`CREATE INDEX IX_TGFPRO_HUB ON TGFPRO(ATIVO, ${params.campoFlag});\`
`;

  return {
    sqlScript: deterministicSql,
    technicalReport,
    generatedByAI: false,
    modelUsed: 'Validador de Conformidade Heurístico',
    auditRows
  };
}

// -----------------------------------------------------------------------------
// 4. FIRESTORE INITIALIZATION
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
// 5. DISPARO DE E-MAIL AO TECH LEAD
// -----------------------------------------------------------------------------
async function sendTechLeadEmail(options: {
  id: string;
  token: string;
  params: OnboardingParams;
  sqlScript: string;
  technicalReport: string;
  baseUrl: string;
}) {
  const { id, token, params, sqlScript, technicalReport, baseUrl } = options;
  const techLeadEmail = process.env.TECH_LEAD_EMAIL || 'techlead@sankhyahub.com.br';
  const fromEmail = process.env.SMTP_FROM || '"Sankhya Hub Onboarding" <no-reply@sankhyahub.com.br>';

  const aprovarUrl = `${baseUrl.replace(/\/$/, '')}/api/aprovar?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  const rejeitarUrl = `${baseUrl.replace(/\/$/, '')}/api/rejeitar?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;

  // Conversão de tabelas Markdown em HTML limpo
  function renderMarkdownTables(md: string): string {
    const tableRegex = /\|(.+)\|\n\|(?:\s*:?-+:?\s*\|)+\n((?:\|.+[^\n]*\n?)*)/g;
    return md.replace(tableRegex, (match, headerLine, bodyLines) => {
      const headers = headerLine.split('|').map((h: string) => h.trim()).filter((h: string) => h.length > 0);
      const rows = bodyLines.trim().split('\n').map((row: string) => {
        return row.split('|').map((c: string) => c.trim()).filter((c: string) => c.length > 0);
      });

      let tableHtml = '<div style="overflow-x: auto; margin: 14px 0;"><table style="width: 100%; border-collapse: collapse; font-size: 11px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px;">';
      tableHtml += '<thead><tr style="background: #e2e8f0; color: #1e293b; font-weight: bold;">';
      for (const h of headers) {
        tableHtml += `<th style="padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;">${h}</th>`;
      }
      tableHtml += '</tr></thead><tbody>';
      for (const r of rows) {
        tableHtml += '<tr style="border-bottom: 1px solid #e2e8f0;">';
        for (const cell of r) {
          tableHtml += `<td style="padding: 6px 8px; border: 1px solid #cbd5e1;">${cell}</td>`;
        }
        tableHtml += '</tr>';
      }
      tableHtml += '</tbody></table></div>';
      return tableHtml;
    });
  }

  const reportWithTables = renderMarkdownTables(technicalReport);

  const reportHtml = reportWithTables
    .replace(/^# (.*$)/gim, '<h2 style="color: #0f172a; margin-top: 18px; margin-bottom: 8px; font-size: 16px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px;">$1</h2>')
    .replace(/^## (.*$)/gim, '<h3 style="color: #1e293b; margin-top: 14px; margin-bottom: 6px; font-size: 14px;">$1</h3>')
    .replace(/^### (.*$)/gim, '<h4 style="color: #334155; margin-top: 10px; margin-bottom: 4px; font-size: 13px;">$1</h4>')
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    .replace(/`([^`]+)`/gim, '<code style="background: #e2e8f0; padding: 2px 4px; border-radius: 4px; font-size: 11px; font-family: monospace;">$1</code>')
    .replace(/^- (.*$)/gim, '<li style="margin-bottom: 4px; font-size: 13px; color: #475569;">$1</li>')
    .replace(/\n\n/gim, '<br>');

  const cli = params.gravacaoCliente || {};
  const ped = params.gravacaoPedido || {};

  let canaisEmailHtml = '';
  if (params.deParaCanais && params.deParaCanais.length > 0) {
    canaisEmailHtml = `
      <div style="margin: 16px 0; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 14px;">
        <h4 style="color: #0f172a; margin-top: 0; margin-bottom: 8px; font-size: 13px; font-weight: bold; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">
          De/Para de Vendedores e Canais (Marketplaces)
        </h4>
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 11px; background: #ffffff;">
            <thead>
              <tr style="background: #f1f5f9; color: #1e293b; font-weight: bold;">
                <th style="padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;">Canal / Marketplace</th>
                <th style="padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;">Cód. Vendedor (tgfven)</th>
                <th style="padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;">Cód. Natureza (CODNAT)</th>
                <th style="padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;">Tipo de Venda (CODTIPVENDA)</th>
              </tr>
            </thead>
            <tbody>
              ${params.deParaCanais.map(c => `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 6px 8px; border: 1px solid #cbd5e1; font-weight: bold; color: #1e293b;">${c.canal}</td>
                  <td style="padding: 6px 8px; border: 1px solid #cbd5e1; font-family: monospace; color: #334155;">${c.codVendedor || '-'}</td>
                  <td style="padding: 6px 8px; border: 1px solid #cbd5e1; font-family: monospace; color: #334155;">${c.codNatureza || '-'}</td>
                  <td style="padding: 6px 8px; border: 1px solid #cbd5e1; font-family: monospace; color: #334155;">${c.codTipVenda || '-'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  let transpEmailHtml = '';
  if (params.deParaTransportadoras && params.deParaTransportadoras.length > 0) {
    transpEmailHtml = `
      <div style="margin: 16px 0; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 14px;">
        <h4 style="color: #0f172a; margin-top: 0; margin-bottom: 8px; font-size: 13px; font-weight: bold; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">
          De/Para de Transportadoras por Marketplace / Parceiro
        </h4>
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 11px; background: #ffffff;">
            <thead>
              <tr style="background: #f1f5f9; color: #1e293b; font-weight: bold;">
                <th style="padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;">Canal / Marketplace</th>
                <th style="padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;">Cód. Transportadora (tgfpar)</th>
                <th style="padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;">Modalidade de Entrega</th>
                <th style="padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;">Regra de Frete</th>
              </tr>
            </thead>
            <tbody>
              ${params.deParaTransportadoras.map(t => `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 6px 8px; border: 1px solid #cbd5e1; font-weight: bold; color: #1e293b;">${t.canal}</td>
                  <td style="padding: 6px 8px; border: 1px solid #cbd5e1; font-family: monospace; color: #334155;">${t.codTransportadora || '-'}</td>
                  <td style="padding: 6px 8px; border: 1px solid #cbd5e1; color: #334155;">${t.modalidade || '-'}</td>
                  <td style="padding: 6px 8px; border: 1px solid #cbd5e1; font-weight: 500; color: ${t.regraFrete === 'Considera' ? '#0369a1' : '#475569'};">${t.regraFrete || 'Não Considera'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="font-family: sans-serif; background: #f4f7fb; color: #1e293b; padding: 20px;">
    <div style="max-width: 680px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
      <h1 style="color: #0284c7; font-size: 20px;">Nova Implantação: ${params.nomeEmpresa}</h1>
      <p style="font-size: 14px; color: #475569;">O Agente de IA validou a conformidade do template SQL, parâmetros de cliente e pedidos, gerando o relatório técnico.</p>
      
      <!-- Bloco de Conectividade e Acesso ao Sankhya MGE & SankhyaOm -->
      <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border: 1px solid #334155; border-radius: 10px; padding: 16px; margin: 16px 0; color: #ffffff;">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 8px; margin-bottom: 10px;">
          <span style="font-size: 11px; font-weight: bold; text-transform: uppercase; color: #38bdf8; letter-spacing: 0.5px;">🔐 Conectividade & Acesso ao Sankhya MGE & SankhyaOm (Teste Imediato)</span>
          <span style="font-size: 10px; background: rgba(56, 189, 248, 0.2); color: #38bdf8; padding: 2px 8px; border-radius: 9999px;">Credenciais API</span>
        </div>
        <div style="font-size: 13px; line-height: 1.6;">
          <div style="margin-bottom: 5px;">
            <strong style="color: #94a3b8;">Link do MGE / Sankhya-W:</strong> 
            <a href="${params.linkMge || '#'}" target="_blank" style="color: #38bdf8; text-decoration: underline; word-break: break-all;">${params.linkMge || 'Não informado'}</a>
          </div>
          <div style="margin-bottom: 5px;">
            <strong style="color: #94a3b8;">Usuário de Integração:</strong> 
            <code style="background: #334155; color: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: monospace;">${params.usuarioSankhya || 'Não informado'}</code>
          </div>
          <div style="margin-bottom: 5px;">
            <strong style="color: #94a3b8;">Senha de Acesso:</strong> 
            <code style="background: #334155; color: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: monospace;">${params.senhaSankhya || '••••••••'}</code>
          </div>
          <div>
            <strong style="color: #94a3b8;">Token SankhyaOm (conectahub):</strong> 
            <code style="background: #1e1b4b; color: #a5b4fc; padding: 2px 6px; border-radius: 4px; font-family: monospace; word-break: break-all;">${params.tokenSankhyaOm || 'Não informado'}</code>
          </div>
        </div>
      </div>

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin: 16px 0; font-size: 13px; line-height: 1.6;">
        <div><strong>Empresa:</strong> ${params.nomeEmpresa} (CNPJ: ${params.cnpj}) | <strong>Banco:</strong> ${params.dbType}</div>
        <div><strong>Estoque:</strong> Empresas (${params.codEmpEstoque}), Locais (${params.locaisEstoque})</div>
        <div><strong>Preços:</strong> Empresa (${params.codEmpPreco}), Local (${params.localPreco}), Tabela (${params.tabelasPreco})</div>
        <div><strong>Gravação Cliente (TGFPAR):</strong> Contato=${cli.criarContatoCliente} | Grupo ICMS=${cli.grupoIcms} | Tabela=${cli.tabelaPrecoCliente} | Tipo Parc=${cli.codTipParc}</div>
        <div><strong>Gravação Pedido (TGFCAB):</strong> TOP=${ped.codTipOper} | Série=${ped.serieNota} | Frete=${ped.tipFrete} | Status=${ped.regraStatusPedido}</div>
        <div><strong>Canais Integrados:</strong> ${params.deParaCanais?.length || 0} | <strong>Transportadoras:</strong> ${params.deParaTransportadoras?.length || 0}</div>
      </div>

      ${canaisEmailHtml}
      ${transpEmailHtml}

      <div style="background: #f1f5f9; border-left: 4px solid #0284c7; padding: 14px; border-radius: 4px; margin: 16px 0; font-size: 13px; line-height: 1.5;">
        ${reportHtml}
      </div>

      <div style="margin-top: 24px; display: flex; gap: 12px;">
        <a href="${aprovarUrl}" style="background: #16a34a; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: inline-block;">
          ✓ Aprovar Implantação
        </a>
        <a href="${rejeitarUrl}" style="background: #dc2626; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: inline-block; margin-left: 12px;">
          ✕ Rejeitar
        </a>
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

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await transporter.sendMail({
        from: fromEmail,
        to: techLeadEmail,
        subject: `[Onboarding Sankhya] Solicitação de Implantação: ${params.nomeEmpresa}`,
        html: htmlContent,
        attachments: [
          {
            filename: `views_sankhya_${params.dbType.toLowerCase()}_emp${params.codEmpEstoque}.sql`,
            content: sqlScript,
            contentType: 'application/sql'
          }
        ]
      });
      console.log(`[ONBOARDING TECH LEAD] E-mail enviado com sucesso via Gmail SMTP para ${techLeadEmail}`);
      return true;
    } catch (err: any) {
      console.warn('[MAILER] Aviso ao enviar e-mail ao Tech Lead via Nodemailer/Gmail:', err?.message || err);
      return false;
    }
  } else {
    console.log(`[SIMULAÇÃO E-MAIL TECH LEAD] Aprovar: ${aprovarUrl}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// 6. SERVERLESS FUNCTION HANDLER
// -----------------------------------------------------------------------------
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).send('OK');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido. Utilize POST.' });

  try {
    const rawBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const {
      nomeEmpresa,
      cnpj,
      emailTecnico,
      linkMge,
      usuarioSankhya,
      senhaSankhya,
      tokenSankhyaOm,
      dbType,
      codEmp,
      codEmpEstoque,
      locaisEstoque,
      regraReserva,
      codEmpPreco,
      localPreco,
      tabelasPreco,
      codEmpFaturamento,
      campoFlag,
      campoEan,
      campoMarca,
      adIntegracaoCode,
      dadosFiscais,
      dePara,
      // Bloco A: Gravação de Cliente (TGFPAR)
      criarContatoCliente,
      grupoIcms,
      tabelaPrecoCliente,
      classificacaoIcms,
      retemIss,
      codTipParc,
      identInscEstad,
      gravacaoCliente: rawGravacaoCliente,
      // Bloco B: Gravação de Pedido (TGFCAB / TGFITE)
      codTipOper,
      serieNota,
      tipFrete,
      regraStatusPedido,
      regraDesconto,
      regraJuros,
      regraIpi,
      gravacaoPedido: rawGravacaoPedido,
      // De/Para de Vendedores e Canais (Marketplaces)
      deParaCanais: rawDeParaCanais,
      // De/Para de Transportadoras por Marketplace
      deParaTransportadoras: rawDeParaTransportadoras
    } = rawBody || {};

    if (!nomeEmpresa || !cnpj || !emailTecnico || !dbType) {
      return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    }

    if (dbType !== 'ORACLE' && dbType !== 'SQL_SERVER') {
      return res.status(400).json({ error: "Banco de dados inválido. Selecione 'ORACLE' ou 'SQL_SERVER'." });
    }

    const resolvedCodEmpEstoque = String(codEmpEstoque || codEmp || '1').trim();
    const resolvedLocaisEstoque = String(locaisEstoque || '0').trim();
    const resolvedCodEmpPreco = String(codEmpPreco || codEmp || '1').trim();
    const resolvedLocalPreco = String(localPreco !== undefined && localPreco !== null && localPreco !== '' ? localPreco : '0').trim();
    const resolvedTabelasPreco = String(tabelasPreco || '1').trim();
    const resolvedCodEmpFaturamento = String(codEmpFaturamento || codEmp || '1').trim();
    const resolvedRegraReserva = String(dadosFiscais?.regraReserva || regraReserva || 'DEDUZIR').trim();

    // Mapeamento Bloco A: Gravação de Cliente
    const gravacaoCliente: ParametrosGravacaoCliente = {
      criarContatoCliente: String(criarContatoCliente || rawGravacaoCliente?.criarContatoCliente || 'Sim').trim(),
      grupoIcms: String(grupoIcms || rawGravacaoCliente?.grupoIcms || '1').trim(),
      tabelaPrecoCliente: String(tabelaPrecoCliente || rawGravacaoCliente?.tabelaPrecoCliente || resolvedTabelasPreco).trim(),
      classificacaoIcms: String(classificacaoIcms || rawGravacaoCliente?.classificacaoIcms || '1').trim(),
      retemIss: String(retemIss || rawGravacaoCliente?.retemIss || 'Não').trim(),
      codTipParc: String(codTipParc || rawGravacaoCliente?.codTipParc || '1').trim(),
      identInscEstad: String(identInscEstad || rawGravacaoCliente?.identInscEstad || '9').trim()
    };

    // Mapeamento Bloco B: Gravação de Pedido
    const resolvedTop = String(codTipOper || rawGravacaoPedido?.codTipOper || dadosFiscais?.codTipOper || '1100').trim();
    const resolvedSerie = String(serieNota || rawGravacaoPedido?.serieNota || dadosFiscais?.serieNota || '1').trim();
    const gravacaoPedido: ParametrosGravacaoPedido = {
      codEmpFaturamento: resolvedCodEmpFaturamento,
      codTipOper: resolvedTop,
      serieNota: resolvedSerie,
      tipFrete: String(tipFrete || rawGravacaoPedido?.tipFrete || 'C').trim(),
      regraStatusPedido: String(regraStatusPedido || rawGravacaoPedido?.regraStatusPedido || 'Liberado').trim(),
      regraDesconto: String(regraDesconto || rawGravacaoPedido?.regraDesconto || 'Desconto').trim(),
      regraJuros: String(regraJuros || rawGravacaoPedido?.regraJuros || 'Juros').trim(),
      regraIpi: String(regraIpi || rawGravacaoPedido?.regraIpi || 'Não Considera').trim()
    };

    // Mapeamento De/Para de Canais e Marketplaces
    let deParaCanais: DeParaCanal[] = [];
    if (Array.isArray(rawDeParaCanais)) {
      deParaCanais = rawDeParaCanais
        .filter((c: any) => c && typeof c === 'object' && c.canal)
        .map((c: any) => ({
          canal: String(c.canal).trim(),
          codVendedor: String(c.codVendedor || '').trim(),
          codNatureza: String(c.codNatureza || '').trim(),
          codTipVenda: String(c.codTipVenda || '').trim()
        }));
    }

    // Mapeamento De/Para de Transportadoras por Marketplace
    let deParaTransportadoras: DeParaTransportadora[] = [];
    if (Array.isArray(rawDeParaTransportadoras)) {
      deParaTransportadoras = rawDeParaTransportadoras
        .filter((t: any) => t && typeof t === 'object' && t.canal)
        .map((t: any) => ({
          canal: String(t.canal).trim(),
          codTransportadora: String(t.codTransportadora || '').trim(),
          modalidade: String(t.modalidade || '').trim(),
          regraFrete: String(t.regraFrete || 'Não Considera').trim()
        }));
    }

    const params: OnboardingParams = {
      nomeEmpresa: String(nomeEmpresa).trim(),
      cnpj: String(cnpj).trim(),
      emailTecnico: String(emailTecnico).trim(),
      dbType: dbType as 'ORACLE' | 'SQL_SERVER',
      codEmp: resolvedCodEmpEstoque,
      codEmpEstoque: resolvedCodEmpEstoque,
      locaisEstoque: resolvedLocaisEstoque,
      regraReserva: resolvedRegraReserva,
      codEmpPreco: resolvedCodEmpPreco,
      localPreco: resolvedLocalPreco,
      tabelasPreco: resolvedTabelasPreco,
      codEmpFaturamento: resolvedCodEmpFaturamento,
      campoFlag: String(campoFlag || adIntegracaoCode || 'AD_ECOMMERCE').trim(),
      campoEan: String(campoEan || 'C.CODBARRA').trim(),
      campoMarca: String(campoMarca || 'COALESCE(P.CODMARCA, M.CODIGO)').trim(),
      adIntegracaoCode: String(campoFlag || adIntegracaoCode || 'AD_ECOMMERCE').trim(),
      linkMge: String(rawBody.linkMge || linkMge || '').trim(),
      usuarioSankhya: String(rawBody.usuarioSankhya || usuarioSankhya || '').trim(),
      senhaSankhya: String(rawBody.senhaSankhya || senhaSankhya || '').trim(),
      tokenSankhyaOm: String(rawBody.tokenSankhyaOm || tokenSankhyaOm || '').trim(),
      gravacaoCliente,
      gravacaoPedido,
      deParaCanais,
      deParaTransportadoras,
      dadosFiscais: {
        codTipOper: resolvedTop,
        serieNota: resolvedSerie,
        regraReserva: resolvedRegraReserva
      },
      dePara: typeof dePara === 'object' && dePara !== null ? dePara : {}
    };

    // 1. Carrega o template correspondente ao banco selecionado
    const rawTemplate = loadTemplate(params.dbType);

    // 2. Validador de Conformidade via Agente de IA preenche os placeholders
    const aiResult = await runComplianceAIAgent(rawTemplate, params);

    const id = uuidv4();
    const token = uuidv4();
    const now = new Date().toISOString();

    // 3. Salva no Firestore incluindo a auditoria de De/Para e parametrizações completas
    const db = getFirestore();
    await db.collection('onboardings').doc(id).set({
      id,
      token,
      status: 'PENDENTE',
      params,
      tokenSankhyaOm: params.tokenSankhyaOm || '',
      conectividade: {
        linkMge: params.linkMge || '',
        usuarioSankhya: params.usuarioSankhya || '',
        senhaSankhya: params.senhaSankhya || '',
        senhaConfigurada: Boolean(params.senhaSankhya),
        tokenSankhyaOm: params.tokenSankhyaOm || ''
      },
      gravacaoCliente,
      gravacaoPedido,
      deParaCanais,
      deParaTransportadoras,
      deParaAudit: aiResult.auditRows,
      sqlScript: aiResult.sqlScript,
      technicalReport: aiResult.technicalReport,
      generatedByAI: aiResult.generatedByAI,
      modelUsed: aiResult.modelUsed,
      createdAt: now,
      updatedAt: now
    });

    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const baseUrl = process.env.BASE_URL || `${proto}://${host}`;

    // 4. Envia ao Tech Lead
    await sendTechLeadEmail({
      id,
      token,
      params,
      sqlScript: aiResult.sqlScript,
      technicalReport: aiResult.technicalReport,
      baseUrl
    });

    return res.status(200).json({
      success: true,
      id,
      status: 'PENDENTE',
      generatedByAI: aiResult.generatedByAI,
      modelUsed: aiResult.modelUsed,
      techLeadNotified: process.env.TECH_LEAD_EMAIL || 'Configurado / Simulado',
      message: 'Solicitação validada pelo Agente de IA em conformidade com o template e registrada com sucesso!'
    });
  } catch (error: any) {
    console.error('[ERRO api/processar]:', error);
    return res.status(500).json({ error: 'Erro interno ao processar.', details: error?.message || String(error) });
  }
}
