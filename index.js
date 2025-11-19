import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import 'dotenv/config';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------
// OPENAI (IA)
// ---------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ---------------------
// CACHE (10 minutos)
// ---------------------
const cacheImoveis = new Map(); 
const CACHE_MS = 10 * 60 * 1000;

// ---------------------
// HELPERS
// ---------------------
function parseNumeroBr(valorStr) {
  if (!valorStr) return 0;
  let s = String(valorStr).trim();
  s = s.replace(/[R$\s]/g, '');
  s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

// ---------------------
// BAIXAR CSV DA CAIXA
// ---------------------
async function fetchCsvCaixa(uf) {
  const ufUpper = uf.toUpperCase();
  const url = `https://venda-imoveis.caixa.gov.br/listaweb/Lista_imoveis_${ufUpper}.csv`;

  console.log(`[Caixa] Baixando CSV: ${url}`);

  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept': 'text/csv,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9'
      },
      timeout: 20000
    });

    console.log('[Caixa] Status:', resp.status, 'Bytes:', resp.data.length);

    return resp.data.toString('latin1');
  } catch (err) {
    if (err.response) {
      console.error('[Caixa] Erro HTTP:', err.response.status);
    } else {
      console.error('[Caixa] Erro de rede:', err.message);
    }
    throw err;
  }
}

// ---------------------
// PARSE DO CSV
// ---------------------
function parseImoveisCsv(csvStr, uf) {
  const records = parse(csvStr, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ';'
  });

  return records.map((row, idx) => {
    return {
      id: idx,
      bruto: row,

      uf: row['UF'] || uf,
      cidade: row['MUNICIPIO'] || row['CIDADE'] || '',
      bairro: row['BAIRRO'] || '',
      logradouro: row['ENDERECO'] || row['LOGRADOURO'] || '',

      modalidade: row['MODALIDADE'] || '',
      tipo: row['TIPO_IMOVEL'] || row['TIPO'] || '',
      situacao: row['SITUACAO'] || '',

      valor: parseNumeroBr(row['VALOR'] || row['VALOR_AVALIACAO'] || ''),
      area: parseNumeroBr(row['AREA_TOTAL'] || row['AREA'] || ''),

      lat: null,
      lng: null
    };
  });
}

// ---------------------
// CARREGAR COM CACHE
// ---------------------
async function getImoveisPorUf(uf) {
  const now = Date.now();
  const cached = cacheImoveis.get(uf);

  if (cached && now - cached.timestamp < CACHE_MS) {
    console.log('[CACHE] Usando cache para UF', uf);
    return cached.data;
  }

  console.log('[CACHE] Baixando UF', uf);
  const csv = await fetchCsvCaixa(uf);
  const imoveis = parseImoveisCsv(csv, uf);

  cacheImoveis.set(uf, { data: imoveis, timestamp: now });
  return imoveis;
}

// ---------------------
// ROTA: Saúde
// ---------------------
app.get('/', (req, res) => {
  res.send('Arremate Certo backend está no ar');
});

// ---------------------
// ROTA: /api/imoveis
// ---------------------
app.get('/api/imoveis', async (req, res) => {
  try {
    const { uf, modalidade, minValor, maxValor } = req.query;

    if (!uf) return res.status(400).json({ error: 'Parâmetro uf é obrigatório' });

    let imoveis = await getImoveisPorUf(uf);

    if (modalidade) {
      imoveis = imoveis.filter(i =>
        (i.modalidade || '')
          .toUpperCase()
          .includes(modalidade.toUpperCase())
      );
    }

    if (minValor) imoveis = imoveis.filter(i => i.valor >= Number(minValor));
    if (maxValor) imoveis = imoveis.filter(i => i.valor <= Number(maxValor));

    res.json(imoveis);
  } catch (err) {
    console.error('Erro /api/imoveis:', err);
    const status = err.response?.status;
    if (status) {
      return res.status(500).json({
        error: `Erro ao carregar imóveis da Caixa (HTTP Caixa ${status})`
      });
    }
    res.status(500).json({
      error: `Erro ao carregar imóveis da Caixa: ${err.message}`
    });
  }
});

// ---------------------
// ROTA: Análise de IA
// ---------------------
app.post('/api/imoveis/analise', async (req, res) => {
  try {
    const imovel = req.body || {};

    const prompt = `
Analise este imóvel de leilão da Caixa e retorne um JSON:

Imóvel:
- UF: ${imovel.uf}
- Cidade: ${imovel.cidade}
- Bairro: ${imovel.bairro}
- Tipo: ${imovel.tipo}
- Modalidade: ${imovel.modalidade}
- Valor: ${imovel.valor}
- Área: ${imovel.area}
- Situação: ${imovel.situacao}

Responda APENAS em JSON com:
{
  "score": (0-100),
  "resumo": "",
  "pontos_positivos": [],
  "pontos_atencao": [],
  "estrategia": ""
}
`;

    const completion = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      response_format: { type: "json_object" }
    });

    const txt = completion.output[0].content[0].text;
    const json = JSON.parse(txt);

    res.json(json);
  } catch (err) {
    console.error('Erro /api/imoveis/analise:', err);
    res.status(500).json({ error: 'Erro ao gerar análise de IA' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
