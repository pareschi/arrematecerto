import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// --- MOCK: alguns imóveis só para teste ---

const imoveisMock = [
  {
    id: 1,
    uf: 'SP',
    cidade: 'Guarujá',
    bairro: 'Pitangueiras',
    logradouro: 'Avenida Marechal Deodoro da Fonseca, 100',
    modalidade: 'Venda Direta',
    valor: 350000,
    area: 70,
    tipo: 'Apartamento',
    situacao: 'Desocupado',
    lat: -23.9925,
    lng: -46.2581
  },
  {
    id: 2,
    uf: 'SP',
    cidade: 'Guarujá',
    bairro: 'Enseada',
    logradouro: 'Rua Guatemala, 250',
    modalidade: 'Leilão',
    valor: 280000,
    area: 60,
    tipo: 'Apartamento',
    situacao: 'Ocupado',
    lat: -23.988,
    lng: -46.246
  },
  {
    id: 3,
    uf: 'SP',
    cidade: 'Santos',
    bairro: 'Gonzaga',
    logradouro: 'Rua Floriano Peixoto, 500',
    modalidade: 'Venda Direta Online',
    valor: 420000,
    area: 80,
    tipo: 'Apartamento',
    situacao: 'Desocupado',
    lat: -23.965,
    lng: -46.3326
  }
];

// Rota simples só para validar que o backend está rodando
app.get('/', (req, res) => {
  res.send('Arremate Certo backend está no ar');
});

// Rota de imóveis (usando MOCK por enquanto)
app.get('/api/imoveis', (req, res) => {
  const { uf, modalidade, minValor, maxValor } = req.query;

  let lista = [...imoveisMock];

  if (uf) {
    lista = lista.filter(i => i.uf.toUpperCase() === uf.toUpperCase());
  }

  if (modalidade) {
    lista = lista.filter(i =>
      (i.modalidade || '').toUpperCase().includes(modalidade.toUpperCase())
    );
  }

  if (minValor) {
    lista = lista.filter(i => i.valor >= Number(minValor));
  }

  if (maxValor) {
    lista = lista.filter(i => i.valor <= Number(maxValor));
  }

  res.json(lista);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor Arremate Certo rodando na porta ${PORT}`);
});
