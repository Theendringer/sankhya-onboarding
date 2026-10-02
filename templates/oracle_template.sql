-- =========================================================================
-- TEMPLATE SANKHYA X HUB (ORACLE DATABASE / PL-SQL)
-- EMPRESA: {{NOME_EMPRESA}} | CNPJ: {{CGC}}
-- CODEMP ESTOQUE: {{CODEMP_ESTOQUE}} | LOCAIS ESTOQUE: {{LOCAIS_ESTOQUE}}
-- CODEMP PREÇO: {{CODEMP_PRECO}} | LOCAL PREÇO: {{LOCAL_PRECO}} | TABELA PREÇO: {{TABELA_PRECO}}
-- CODEMP FATURAMENTO: {{CODEMP_FATURAMENTO}} | FLAG: {{CAMPO_FLAG}}
--
-- PARÂMETROS DE GRAVAÇÃO DE CLIENTE (TGFPAR):
-- CRIAR CONTATO: {{CRIAR_CONTATO}} | GRUPO ICMS: {{GRUPO_ICMS}} | TABELA PREÇO: {{TABELA_PRECO_CLIENTE}}
-- CLASSIFICAÇÃO ICMS: {{CLASSIFICACAO_ICMS}} | RETÉM ISS: {{RETEM_ISS}} | TIPO PARCEIRO: {{CODTIPPARC}}
-- INSCRIÇÃO ESTADUAL: {{IDENTINSCESTAD}}
--
-- PARÂMETROS DE GRAVAÇÃO DE PEDIDO (TGFCAB / TGFITE):
-- OPERAÇÃO FISCAL (TOP): {{CODTIPOPER}} | SÉRIE: {{SERIENOTA}} | TIPO FRETE: {{TIPFRETE}}
-- STATUS PEDIDO: {{REGRA_STATUS_PEDIDO}} | DESCONTO: {{REGRA_DESCONTO}}
-- JUROS: {{REGRA_JUROS}} | IPI: {{REGRA_IPI}}
--
-- DE/PARA DE VENDEDORES E CANAIS (MARKETPLACES):
{{DEPARA_CANAIS}}
--
-- DE/PARA DE TRANSPORTADORAS POR MARKETPLACE (TGFPAR):
{{DEPARA_TRANSPORTADORAS}}
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. VIEW DE PRODUTOS PARA INTEGRAÇÃO COM HUB (TGFPRO / TGFBAR / TGFMAR)
-- -------------------------------------------------------------------------
CREATE OR REPLACE VIEW CH_VIEW_PRODUTO AS
SELECT 
    {{CAMPO_CODIGO}} AS CODIGO,
    {{CAMPO_CODIGOERP}} AS CODIGOERP,
    {{CAMPO_NOME}} AS NOME,
    {{CAMPO_DESCRICAO}} AS DESCRICAO,
    {{CAMPO_CATEGORIA}} AS CATEGORIA,
    {{CAMPO_FABRICANTE}} AS FABRICANTE,
    {{CAMPO_MARCA}} AS MARCA,
    {{CAMPO_MODELO}} AS MODELO,
    {{CAMPO_STATUS}} AS STATUS,
    {{CAMPO_GARANTIA}} AS GARANTIA,
    {{CAMPO_EAN}} AS CODIGOUNIVERSAL,
    {{CAMPO_ORIGEM}} AS ORIGEM,
    {{CAMPO_NCM}} AS NCM,
    {{CAMPO_UNIDADEMEDIDA}} AS UNIDADEMEDIDA,
    'novo' AS CONDICAO,
    {{CAMPO_ALTURA}} AS ALTURA,
    {{CAMPO_LARGURA}} AS LARGURA,
    {{CAMPO_PROFUNDIDADE}} AS PROFUNDIDADE,
    {{CAMPO_PESO}} AS PESO,
    ROW_NUMBER() OVER (ORDER BY p.codprod) AS LINHA_TABELA
FROM tgfpro p 
LEFT JOIN TGFBAR C ON p.codprod = C.codprod 
LEFT JOIN TGFMAR M ON p.marca = m.descricao
WHERE p.{{CAMPO_FLAG}} = 'S';

-- -------------------------------------------------------------------------
-- 2. VIEW DE SALDO DE ESTOQUE DISPONÍVEL CONSOLIDADO (TGFEST & TSIEMP)
-- -------------------------------------------------------------------------
CREATE OR REPLACE VIEW CH_VIEW_ESTOQUE AS
SELECT 
    emp.CGC AS EMPRESA,
    TO_CHAR(p.codprod) AS PRODUTO,
    e.codlocal AS LOCAL,
    CASE 
        WHEN SUM({{EXPR_ESTOQUE_SALDO}}) IS NULL THEN '0' 
        ELSE TO_CHAR(SUM({{EXPR_ESTOQUE_SALDO}})) 
    END AS ESTOQUEATUAL,
    ROUND(SANKHYA.SNK_PRECO(0, p.codprod), 1) AS CUSTO,
    ROW_NUMBER() OVER (PARTITION BY emp.CGC ORDER BY p.codprod) AS LINHA_TABELA
FROM tgfpro p 
LEFT JOIN tgfest e ON p.codprod = e.codprod AND e.codlocal IN ({{LOCAIS_ESTOQUE}}) AND e.codemp IN ({{CODEMP_ESTOQUE}}) 
LEFT JOIN TSIEMP emp ON e.codemp = emp.codemp
WHERE p.ATIVO = 'S'
GROUP BY emp.CGC, p.codprod, e.codlocal;

-- -------------------------------------------------------------------------
-- 3. VIEW DE PREÇO POR PRODUTO E TABELA CONFIGURADA (SNK_PRECO & TGFTAB)
-- -------------------------------------------------------------------------
CREATE OR REPLACE VIEW CH_VIEW_PRECO AS
SELECT 
    emp.CGC AS EMPRESA,
    TO_CHAR(p.codprod) AS PRODUTO,
    ROUND(SANKHYA.SNK_PRECO({{TABELA_PRECO}}, p.codprod), 1) AS PRECO,
    '{{TABELA_PRECO}}' AS TABELAPRECO,
    ROW_NUMBER() OVER (ORDER BY p.codprod) AS LINHA_TABELA
FROM tgfpro p 
LEFT JOIN tgfest e ON p.codprod = e.codprod AND e.codlocal = {{LOCAL_PRECO}} AND e.codemp = {{CODEMP_PRECO}}
LEFT JOIN TSIEMP emp ON emp.codemp = {{CODEMP_PRECO}}
WHERE p.ATIVO = 'S' 
  AND p.{{CAMPO_FLAG}} = 'S';

-- -------------------------------------------------------------------------
-- 4. VIEW DE PEDIDOS FATURADOS E ITENS DA NOTA (TGFCAB, TGFITE, TGFVAR)
-- -------------------------------------------------------------------------
CREATE OR REPLACE VIEW CH_VIEW_PEDIDOFATURADO AS
SELECT 
    c.numnota AS DOCUMENTO_NUMERO, 
    c.serienota AS DOCUMENTO_SERIE, 
    c.chavenfe AS DOCUMENTO_CHAVE, 
    TO_CHAR((SELECT MAX(codcfo) FROM tgfite WHERE nunota = c.nunota)) AS DOCUMENTO_CFOP, 
    TO_CHAR(c.vlrnota) AS DOCUMENTO_VALORTOTAL, 
    TO_CHAR(c.dtfatur, 'YYYY-MM-DD"T"HH24:MI:SS') AS DOCUMENTO_DATAEMISSAO, 
    '/pedido/xml?chavexml=' || c.chavenfe AS DOCUMENTO_URLXML,
    (SELECT nunotaorig FROM tgfvar WHERE nunota = c.nunota AND ROWNUM = 1) AS CODIGOERP, 
    ROW_NUMBER() OVER (ORDER BY c.chavenfe) AS LINHA_TABELA
FROM tgfcab c
WHERE c.NUMNOTA <> 0 
  AND c.STATUSNFE = 'A'
  AND c.CODEMP IN ({{CODEMP_FATURAMENTO}});

-- -------------------------------------------------------------------------
-- 5. VIEW DE XML E DADOS FISCAIS DE NOTAS FATURADAS (SANKHYA.TGFNFE)
-- -------------------------------------------------------------------------
CREATE OR REPLACE VIEW CH_VIEW_PEDIDOFATURADOXML AS
SELECT 
    n.CHAVENFE, 
    SUBSTR(n.XMLENVCLI, 1, 4000) AS XML1, 
    SUBSTR(n.XMLENVCLI, 4001, 4000) AS XML2, 
    SUBSTR(n.XMLENVCLI, 8001, 4000) AS XML3, 
    SUBSTR(n.XMLENVCLI, 12001, 4000) AS XML4, 
    SUBSTR(n.XMLENVCLI, 16001, 4000) AS XML5, 
    SUBSTR(n.XMLENVCLI, 20001, 4000) AS XML6, 
    SUBSTR(n.XMLENVCLI, 24001, 4000) AS XML7, 
    SUBSTR(n.XMLENVCLI, 28001, 4000) AS XML8, 
    SUBSTR(n.XMLENVCLI, 32001, 4000) AS XML9, 
    SUBSTR(n.XMLENVCLI, 36001, 4000) AS XML10
FROM SANKHYA.TGFNFE n;
