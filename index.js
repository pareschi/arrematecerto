import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import 'dotenv/config';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json());

// Config IA (exemplo com OpenAI; ajustar para o provedor que você usar)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Cache simples em memória por UF (MVP)
const cacheImoveis = new Map();

/**
 * Faz a chamada ao formulário da Caixa e obtém o CSV.
 * IMPORTANTE: ajustar método (GET/POST) e parâmetros exatos
 * de acordo com o que você ver no DevTools do navegador.
 */
async function fetchCaixaCsv(uf) {
  // Exemplo genérico – provavelmente será um POST com form-data.
  const url = 'https://venda-imoveis.caixa.gov.br/sistema/download-lista.asp';

  const response = await axios.post(
    url,
    new URLSearchParams({
      'estado': uf    // TODO: ajustar nome do parâmetro para o real
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      responseType: 'arraybuffer' // garante que vem binário/CSV cru
    }
  );

  return response.data.toString('latin1'); // ou utf-8 dependendo do retorno
}

/**
 * Faz o parse do CSV em um array de objetos.
 */
function parseImoveisCsv(csvString) {
  const records = parse(csvString, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ';' // geralmente CSV da Caixa vem com ;, mas confira
  });

  // Normaliza alguns campos (exemplo)
  return records.map((row, idx) => {
    const valor = Number(
      (row['VALOR_IMOVEL'] || row['Valor'] || '0')
        .replace('.', '')
        .replace(',', '.')
    );

    const area = Number(
      (row['AREA_TOTAL'] || row['Area'] || '0')
        .replace('.', '')
        .replace(',', '.')
    );

    return {
      id: idx, // pode criar um id único a partir de hash, etc.
      bruto: row,
      uf: row['UF'] || uf,
      cidade: row['MUNICIPIO'] || row['Cidade'],
      bairro: row['BAIRRO'] || row['Bairro'],
      logradouro: row['ENDERECO'] || row['Endereco'],
      modalidade: row['MODALIDADE'] || row['Modalidade'],
      valor,
      area,
      tipo: row['TIPO'] || row['TipoImovel'],
      situacao: row['SITUACAO'] || row['Situacao'],
      // Geocodificação será preenchida depois
      lat: null,
      lng: null
    };
  });
}

/**
 * Geocodificação dummy (MVP). 
 * Depois você troca por Google Geocoding, Nominatim, etc.
 */
async function geocodeImoveis(imoveis) {
  // MVP: não chama nada externo, só devolve sem lat/lng.
  // Em produção, aqui você faria:
  // - Montar string de endereço
  // - Chamar API externa
  // - Salvar lat/lng
  return imoveis;
}

/**
 * Integra tudo: baixa, parseia e geocodifica.
 */
async function carregarImoveisUf(uf) {
  const csv = await fetchCaixaCsv(uf);
  const imoveis = parseImoveisCsv(csv);
  const geoImoveis = await geocodeImoveis(imoveis);
  return geoImoveis;
}

// GET /api/imoveis?uf=SP&modalidade=...&minValor=...&maxValor=...
app.get('/api/imoveis', async (req, res) => {
  try {
    const { uf, modalidade, minValor, maxValor } = req.query;
    if (!uf) {
      return res.status(400).json({ error: 'Parâmetro uf é obrigatório' });
    }

    // Cache básico por 10 minutos
    const cached = cacheImoveis.get(uf);
    const now = Date.now();
    let imoveis;

    if (cached && now - cached.timestamp < 10 * 60 * 1000) {
      imoveis = cached.data;
    } else {
      imoveis = await carregarImoveisUf(uf);
      cacheImoveis.set(uf, { data: imoveis, timestamp: now });
    }

    // Filtros
    let filtrados = imoveis;

    if (modalidade) {
      filtrados = filtrados.filter(
        i => (i.modalidade || '').toUpperCase().includes(modalidade.toUpperCase())
      );
    }

    if (minValor) {
      filtrados = filtrados.filter(i => i.valor >= Number(minValor));
    }

    if (maxValor) {
      filtrados = filtrados.filter(i => i.valor <= Number(maxValor));
    }

    res.json(filtrados);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao carregar imóveis' });
  }
});

/**
 * Rota para análise de viabilidade com IA.
 * Recebe dados do imóvel e devolve um texto + score.
 */
app.post('/api/imoveis/analise', async (req, res) => {
  try {
    const imovel = req.body;

    const prompt = `
Você é um analista especializado em imóveis de leilão da Caixa.

Analise o seguinte imóvel com foco em viabilidade de arremate:

Dados:
- UF: ${imovel.uf}
- Cidade: ${imovel.cidade}
- Bairro: ${imovel.bairro}
- Tipo: ${imovel.tipo}
- Modalidade: ${imovel.modalidade}
- Valor: R$ ${imovel.valor}
- Área: ${imovel.area} m²
- Situação: ${imovel.situacao}

Retorne em JSON com:
- "score": número de 0 a 100 (quanto maior, mais interessante o arremate)
- "resumo": texto curto explicando o perfil do imóvel
- "pontos_positivos": lista curta
- "pontos_atencao": lista curta
- "estrategia": orientação prática para o investidor.

Não invente informações que não estejam nos dados. Use critérios genéricos: desconto potencial, tipo, ocupação, simplicidade da modalidade etc.
`;

    const completion = await openai.responses.create({
      model: 'gpt-4.1-mini', // ou o modelo que preferir
      input: prompt,
      response_format: { type: 'json_object' }
    });

    const json = JSON.parse(completion.output[0].content[0].text);
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao gerar análise de IA' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Arremate Certo backend rodando na porta ${PORT}`);
});
