import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// Rota simples só para validar que o backend está rodando
app.get('/', (req, res) => {
  res.send('Arremate Certo backend está no ar 🚀');
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor Arremate Certo rodando na porta ${PORT}`);
});
