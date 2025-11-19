import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import 'dotenv/config';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json());

// ---------- IA (OpenAI) ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ---------- Cache simples por UF ----------
const cacheImoveis = new Map(); // { uf: { data, timestamp } }
const CACHE_MS = 10 * 60 * 1000; // 10 minutos

// ---------- Helpers ----------
function parseNumeroBr(valorStr) {
  if (!valorStr) return 0;
  // remove espaços
  let s = String(valorStr).trim();
  // tira qualquer símbolo de moeda
  s = s.replace(/[R$\s]/g, '');
  // milhar com . e decimal com ,
  s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Baixa o CSV direto do site da Caixa:
 * https://venda-imoveis.caixa.gov.br/listaweb/Lista_imoveis_[UF].csv
 */
async function fetchCsvCaixa(uf) {
  const ufUpper = uf.toUpperCase();
  const url = `https://venda-imoveis.caixa.gov.br/listaweb/Lista_imoveis_${ufUpper}.csv`;

  const resp = await axios.get(url, {
    responseType: 'arraybuffer' // pra não quebrar acentuação
  });

  // muitos CSVs da Caixa vêm em latin1; se der caractere estranho, troca pra 'utf-8'
  return resp.data.toString('latin1');
}

/**
 * Converte o CSV em array de imóveis normalizados.
 * IMPORTANTE: depois que você olhar um CSV real, ajuste os nomes das colunas aqui.
 */
function parseImoveisCsv(csvString, uf) {
  const records = parse(csvString, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ';'
  });

  return records.map((row, idx) => {
    // Ajuste os nomes conforme o cabeçalho real do CSV
    const cidade  = row['MUNICIPIO'] || row['Município'] || row['CIDADE'] || '';
    const bairro  = row['BAIRRO'] || row['Bairro'] || '';
    const lograd  = row['ENDERECO'] || row['Endereço'] || row['LOGRADOURO'] || '';
    const modalidade = row['MODALIDADE'] || row['Modalidade'] || '';
    const tipo    = row['TIPO_IMOVEL'] || row['Tipo de Imóvel'] || row['TIPO'] || '';
    const situacao = row['SITUACAO'] || row['Situação'] || '';
    const valor   = parseNumeroBr(row['VALOR'] || row['Valor'] || row['VALOR_AVALIACAO'] || '');
    const area    = parseNumeroBr(row['AREA_TOTAL'] || row['Área Total'] || row['AREA'] || '');

    return {
      id: idx,        // você pode depois usar um ID do próprio CSV se tiver
      bruto: row,     // linha completa para uso futuro
      uf: row['UF'] || uf,
      cidade,
      bairro,
      logradouro: lograd,
      modalidade,
      valor,
      area,
      tipo,
      situacao,
      // por enquanto sem geocodificação real
      lat: null,
      lng: null
    };
  });
}

/**
 * Carrega imóveis de uma UF usando cache.
 */
async function getImoveisPorUf(uf) {
  const now = Date.now();
  const cached = cacheImoveis.get(uf);

  if (cached && now - cached.timestamp < CACHE_MS) {
    return cached.data;
  }

  const csv = await fetchCsvCaixa(uf);
  const imoveis = parseImoveisCsv(csv, uf);
  cacheImoveis.set(uf, { data: imoveis, timestamp: now });
  return imoveis;
}

// ---------- Rotas ----------

// Saúde do serviço
app.get('/', (req, res) => {
  res.send('Arremate Certo backend está no ar');
});

// Lista de imóveis reais da Caixa (por UF + filtros básicos)
app.get('/api/imoveis', async (req, res) => {
  try {
    const { uf, modalidade, minValor, maxValor } = req.query;
    if (!uf) {
      return res.status(400).json({ error: 'Parâmetro uf é obrigatório (ex: ?uf=SP)' });
    }

    let imoveis = await getImoveisPorUf(uf);

    if (modalidade) {
      imoveis = imoveis.filter(i =>
        (i.modalidade || '').toUpperCase().includes(modalidade.toUpperCase())
      );
    }

    if (minValor) {
      imoveis = imoveis.filter(i => i.valor >= Number(minValor));
    }

    if (maxValor) {
      imoveis = imoveis.filter(i => i.valor <= Number(maxValor));
    }

    res.json(imoveis);
  } catch (err) {
    console.error('Erro /api/imoveis:', err.message);
    res.status(500).json({ error: 'Erro ao carregar imóveis da Caixa' });
  }
});

/**
 * Rota de análise de viabilidade com IA.
 * Recebe o objeto do imóvel (como o front recebe do /api/imoveis).
 */
app.post('/api/imoveis/analise', async (req, res) => {
  try {
    const imovel = req.body || {};

    const prompt = `
Você é um analista especializado em imóveis de leilão da Caixa.

Analise o seguinte imóvel com foco em viabilidade de arremate (não invente dados além do que está aqui):

Dados:
- UF: ${imovel.uf || ''}
- Cidade: ${imovel.cidade || ''}
- Bairro: ${imovel.bairro || ''}
- Tipo: ${imovel.tipo || ''}
- Modalidade: ${imovel.modalidade || ''}
- Valor: R$ ${imovel.valor || ''}
- Área: ${imovel.area || ''} m²
- Situação: ${imovel.situacao || ''}

Responda em JSON com os campos:
- "score": número de 0 a 100 (quanto maior, maior a atratividade do arremate)
- "resumo": texto curto (2 ou 3 frases) explicando o perfil do imóvel
- "pontos_positivos": array de textos curtos
- "pontos_atencao": array de textos curtos
- "estrategia": texto com uma recomendação prática para o investidor.

Use apenas critérios genéricos baseados nessas informações: tipo, modalidade, valor relativo (mesmo sem média de mercado), ocupação/situação e localização.
`;

    const completion = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: prompt,
      response_format: { type: 'json_object' }
    });

    const txt = completion.output[0].content[0].text;
    const json = JSON.parse(txt);
    res.json(json);
  } catch (err) {
    console.error('Erro /api/imoveis/analise:', err.message);
    res.status(500).json({ error: 'Erro ao gerar análise de IA' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor Arremate Certo rodando na porta ${PORT}`);
});
