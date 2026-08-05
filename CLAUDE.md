# Siquara Analytics — Claude Code

## O que este projeto faz

Servidor Node.js hospedado no Railway que:
1. Roda o agente Meta ADS todo dia as 8h (node-cron)
2. Busca dados da Meta Marketing API (campanhas, anuncios, criativos, Instagram)
3. Analisa com Claude (Anthropic) e gera insights de performance e criativos
4. Salva dados em /data/dados.json (Railway Volume)
5. Serve uma API REST em /api/dados para o dashboard consultar

Projeto independente do palmital-server, criado como base para o cliente
Siquara Mattos. Sem captação/atribuicao por WhatsApp ou atendentes — o foco
e performance de campanhas, criativos (video vs estatico), alcance e
engajamento.

## Como rodar localmente

```bash
npm install
cp .env.example .env
# preencha o .env com suas credenciais
npm run dev
```

## Como fazer deploy no Railway

1. Crie um novo projeto em railway.app (New Project > Deploy from GitHub repo)
2. Conecte ao repositorio gerandoimpulso-suporte2/siquara-server
3. Adicione as variaveis de ambiente (Settings > Variables)
4. Adicione um Volume em /data para persistencia
5. Deploy automatico a cada push no GitHub

## Endpoints da API

- GET  /health          — status do servidor
- GET  /api/dados       — dados completos (campanhas, anuncios, organico, analise)
- GET  /api/resumo      — apenas o resumo de KPIs
- GET  /api/campaigns   — campanhas Meta ADS
- GET  /api/insights    — insights por campanha
- GET  /api/criativos   — performance de criativos (com imagens reais)
- GET  /api/organico    — posts organicos do Instagram
- GET  /api/analyze     — analise completa via Claude
- POST /api/executar    — dispara o agente manualmente (requer Authorization header)
- POST /api/setup       — configura credenciais e roda o agente numa unica chamada
- POST /api/token       — atualiza credenciais em runtime (requer Authorization header)

## Variaveis de ambiente necessarias

```
META_ACCESS_TOKEN=
META_AD_ACCOUNT_ID=
ANTHROPIC_API_KEY=
INSTAGRAM_ACCOUNT_ID=
DAYS_BACK=7
API_SECRET=siquara2025
PORT=3000
```

## Login do dashboard

```
siquara / siquara@2025   → acesso Siquara Mattos
gerando / impulso@2025   → admin agencia
admin   / admin123       → admin agencia
```

## Estrutura

```
siquara-server/
  server.js          — servidor Express + agente + cron
  dashboard/
    dashboard.html   — dashboard (5 telas: Resumo, Campanhas, Criativos, Organico, Analise IA)
  package.json
  .env.example
  .gitignore
  CLAUDE.md
  data/              — criado automaticamente pelo Railway Volume
    dados.json
```

## Quando o token Meta expirar

O token de sistema do Business Manager nao expira se for de usuario de sistema.
Se expirar, gerar novo token de sistema no Business Manager do cliente e
atualizar a variavel META_ACCESS_TOKEN no Railway.
