# Moveo Bot — README

> **Stack**: Next.js (App Router), TypeScript, Google APIs (Sheets/Calendar), OpenAI (Chat Completions), Node/Vercel Runtime.
>
> **Rotas** (cada uma com seu `route.ts`):
> - `app/api/getUserData/route.ts`
> - `app/api/getCalendarData/route.ts`
> - `app/api/editData/route.ts`

Este README detalha a lógica e o funcionamento do código, cobrindo as três rotas de webhook utilizadas pela Moveo, a camada de integrações (`/lib/google.ts` e `/lib/openai.ts`), formato de resposta **obrigatório** para a Moveo e a proposta de **dupla verificação da última mensagem** (anti-condição de corrida).

---

## 1) Visão geral da arquitetura

```
Moveo (Dialog/Agent)
   └─> Webhooks HTTP (Next.js App Router)
         ├─ /app/api/getUserData/route.ts   (dados do usuário — Sheets)
         ├─ /app/api/getCalendarData/route.ts (agenda — Calendar)
         └─ /app/api/editData/route.ts     (interpretação + edição — OpenAI + Sheets)

/lib/google.ts  → Auth Google + export { sheets, calendar }
/lib/openai.ts  → Client OpenAI + export { getEditInstruction }
```

### Contrato com a Moveo (sempre)
A **resposta** de qualquer webhook **precisa** vir no envelope abaixo (chave e conteúdo livres):
```json
{ "output": { "live_instructions": { "<chave>": "<mensagem>" } } }
```
> Você pode devolver só valores e deixar a Moveo gerar a frase, **mas** para ter controle/segurança do que o usuário verá, recomenda‑se devolver a **mensagem pronta**.

---

## 2) Integrações

### 2.1 `/lib/google.ts`
- Autenticação via **Service Account** com `googleapis`.
- Exporta **`sheets`** (v4) e **`calendar`** (v3) já autenticados.
- Permissões: `spreadsheets`, `calendar`.
- O **calendário do usuário** deve estar **compartilhado** com o e‑mail da Service Account (ou a SA deve ter acesso ao recurso). Caso contrário, o Google retorna erro 404/403.

**ENV**
```ini
GOOGLE_CREDENTIALS_PATH="/abs/path/credenciais.json"
```

### 2.2 `/lib/openai.ts`
- Cliente OpenAI com `OPENAI_API_KEY`.
- Função **`getEditInstruction(conversation: string, userPhone: string)`**: usa Chat Completions (modelo `gpt-5-nano`), retorna **JSON** com a instrução estruturada para edição (ex.: `{"action":"update_phone","data":{"new_phone":"+55 11 9 9999-9999"}}`).
- Erros tratados: conversa vazia, resposta vazia e JSON inválido.

**ENV**
```ini
OPENAI_API_KEY="sk-..."
```

---

## 3) Rotas de Webhook

### 3.1 `app/api/getUserData/route.ts`
**Objetivo**: Buscar dados do usuário (normalmente em **Google Sheets**) a partir de identificadores do contexto (e‑mail/telefone), e responder em formato pronto para o chat.

**Entrada (exemplo)**
```json
{
  "context": {
    "session_id": "sess_123",
    "session_variables": {
      "user_email": "usuario@empresa.com",
      "user_phone": "+55 11 9 8888-7777"
    }
  }
}
```

**Passos típicos**
1. Validar e extrair `user_email`/`user_phone` do contexto.
2. Consultar **Sheets** (por e‑mail ou telefone) e montar o objeto de retorno (nome, telefone atual, campos adicionais).
3. Construir **mensagem pronta** (texto/markdown) com os dados relevantes.
4. Responder no envelope `output.live_instructions`.

**Resposta (exemplo)**
```json
{
  "output": {
    "live_instructions": {
      "dados": "Encontrei seu cadastro: Nome: *Ana Silva* — Telefone: *(11) 98888-7777*."
    }
  }
}
```

**Erros comuns**
- Usuário não encontrado na planilha → mensagem clara orientando atualização de cadastro.
- Falha de acesso ao Sheets → mensagem amigável + log de erro interno.

---

### 3.2 `app/api/getCalendarData/route.ts`
**Objetivo**: Listar próximos compromissos do usuário usando **Google Calendar**.

**Entrada (exemplo)**
```json
{
  "context": {
    "session_id": "sess_123",
    "session_variables": {
      "user_email": "usuario@empresa.com"
    }
  }
}
```

**Passos típicos**
1. Validar `user_email`.
2. Chamar `calendar.events.list` (ex.: próximos 7 dias) com `singleEvents: true` e `orderBy: 'startTime'`.
3. Formatar eventos em **markdown** (título, início/fim, local/link).
4. Responder no envelope `output.live_instructions`.

**Resposta (exemplo)**
```json
{
  "output": {
    "live_instructions": {
      "agenda": "# Sua agenda (próximos 7 dias)\n• *Qua, 10/09, 14:00–15:00* — Reunião com Felipe (Meet)\n• *Qui, 11/09, 09:30–10:00* — Follow‑up Comercial"
    }
  }
}
```

**Erros comuns**
- E‑mail ausente → informe que não foi fornecido.
- 403/404 → calendário não está compartilhado com a Service Account.
- Exceção genérica → mensagem amigável e status 500.

---

### 3.3 `app/api/editData/route.ts`
**Objetivo**: Interpretar a intenção do usuário (via **OpenAI**) e **aplicar a edição** em **Google Sheets** (ou outra fonte), respondendo com uma frase pronta de confirmação.

**Entrada (exemplo)**
```json
{
  "context": {
    "session_id": "sess_123",
    "session_variables": {
      "user_email": "usuario@empresa.com",
      "user_phone": "+55 11 9 8888-7777"
    },
    "messages": [ /* histórico bruto, se enviado pela Moveo */ ]
  }
}
```

**Passos típicos**
1. (Opcional, mas recomendado) Rodar **dupla verificação** da última mensagem da sessão (ver Seção 4) e montar `conversation` estável.
2. Chamar **`getEditInstruction(conversation, userPhone)`**.
3. Validar o JSON retornado: `action` e `data`.
4. Executar a ação (ex.: `update_phone` → localizar linha no Sheets e atualizar; `create_meeting` → Calendar, etc.).
5. Construir **mensagem pronta** de confirmação.
6. Responder no envelope `output.live_instructions`.

**Resposta (exemplos)**
- Atualização de número:
```json
{
  "output": {
    "live_instructions": {
      "edit": "Feito! Seu número foi atualizado para +55 11 9 9999‑9999."
    }
  }
}
```
- Reunião marcada:
```json
{
  "output": {
    "live_instructions": {
      "agenda": "Reunião marcada com Felipe para quarta‑feira às 14h."
    }
  }
}
```

**Erros comuns**
- JSON inválido vindo do modelo → peça para o usuário reformular; logue a resposta para ajuste de prompt.
- Ação não suportada → responda informando que ainda não é possível executar essa edição.
- Falha no Sheets/Calendar → mensagem amigável, sem vazar detalhes sensíveis.

---

## 4) Dupla verificação da **última mensagem** (anti‑corrida)

Para evitar processar um estado desatualizado do chat, faça **double‑check** no `editData` (e pode aplicar também em `getUserData` quando a resposta depender do texto mais recente do usuário):

**Fluxo**
1. Obter `session_id` do corpo do webhook.
2. Buscar o histórico (ex.: via Moveo Analytics `log_session_content_v2`).
3. `await delay(600–900ms)`.
4. Buscar novamente e comparar **ID/timestamp** da última mensagem do usuário.
5. Se **iguais**, a última mensagem está **estável**; prossiga. Se **diferentes**, use a versão mais nova.
6. (Opcional) Cache de idempotência por `session_id + last_user_message_id`.

**Esqueleto (TypeScript)**
```ts
async function fetchSessionMessages(sessionId: string) { /* sua query GraphQL */ }
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function getStableLastMessage(sessionId: string) {
  const a = await fetchSessionMessages(sessionId);
  await delay(700);
  const b = await fetchSessionMessages(sessionId);

  const lastA = a?.messages?.at(-1);
  const lastB = b?.messages?.at(-1);
  if (!lastA || !lastB) return null;
  return (lastA.id === lastB.id) ? lastB : lastB; // se mudou, use a mais nova
}
```
> Onde encaixar: logo no topo do `editData` antes de chamar o OpenAI. Se o seu corpo já vier com `messages`, ainda assim vale checar o store oficial (Moveo Analytics) para garantir persistência.

---

## 5) Convenções de código
- Use seus **aliases**: `import { sheets, calendar } from '@/lib/google'` e `import { getEditInstruction } from '@/lib/openai'`.
- **Sem Zod**: valide com checagens simples e `try/catch`, retornando mensagens claras no `live_instructions`.
- Centralize strings comuns (ex.: chaves de `live_instructions`) para padronizar tom e evitar divergências.

---

## 6) Exemplos de teste (cURL)

### 6.1 `getUserData`
```bash
curl -X POST http://localhost:3000/api/getUserData \
  -H 'Content-Type: application/json' \
  -d '{
    "context": {
      "session_id": "sess_123",
      "session_variables": { "user_email": "usuario@empresa.com" }
    }
  }'
```

### 6.2 `getCalendarData`
```bash
curl -X POST http://localhost:3000/api/getCalendarData \
  -H 'Content-Type: application/json' \
  -d '{
    "context": {
      "session_id": "sess_123",
      "session_variables": { "user_email": "usuario@empresa.com" }
    }
  }'
```

### 6.3 `editData`
```bash
curl -X POST http://localhost:3000/api/editData \
  -H 'Content-Type: application/json' \
  -d '{
    "context": {
      "session_id": "sess_123",
      "session_variables": {
        "user_email": "usuario@empresa.com",
        "user_phone": "+55 11 9 8888-7777"
      }
    }
  }'
```
> Obs.: em produção, o `conversation` pode ser reconstruído via `getStableLastMessage` + `log_session_content_v2`.

---

## 7) Tratamento de erros (guidelines)
- **Inputs ausentes**: explique o que faltou (e‑mail/telefone) e como resolver.
- **Permissões Google**: explique que o calendário/planilha não está compartilhado corretamente com a Service Account.
- **OpenAI**: se não vier JSON válido, peça para o usuário confirmar a instrução em uma frase simples; logue para ajustar o prompt.
- **500 genérico**: responda com uma mensagem neutra e registre o erro internamente.

---

## 8) Execução local
```bash
npm i
npm run dev
# ou build
npm run build && npm run start
```
- Garanta que `GOOGLE_CREDENTIALS_PATH` e `OPENAI_API_KEY` estejam definidos.
- A Service Account deve ter acesso aos recursos de destino.

---

## 9) Checklist de produção
- [ ] Service Account com permissões e recursos compartilhados (Calendar/Sheets).
- [ ] Rate limits e retries (Google/OpenAI) com backoff exponencial.
- [ ] Logs sem vazar PII/segredos; inclua `session_id`/`request_id`.
- [ ] Idempotência por `session_id + last_user_message_id`.
- [ ] Timeouts curtos + respostas de **fallback**.

---

## 10) Roadmap sugerido
- **Busca de histórico** (resumo em markdown): webhook auxiliar usando `log_session_content_v2`.
- **Confirmação antes de ações destrutivas** no `editData`.
- **Validações de domínio** (ex.: formato de telefone) “brand‑safe”.
- **Observabilidade**: traços por rota (p95/p99) e alertas de falha por integração.

---

## 11) FAQ
**Posso devolver HTML?**
> Use principalmente texto/markdown. Valide na Moveo se HTML enriquecido é suportado no contexto atual.

**Preciso do histórico inteiro para o `editData`?**
> Não necessariamente; pegue as últimas N mensagens mais relevantes. A **dupla verificação** ajuda a garantir consistência.

**E se o usuário pedir algo que não mapeia para ação?**
> Responda educadamente que ainda não é suportado e proponha alternativas (ex.: atualizar telefone/e‑mail; criar evento; etc.).

---

**Fim.**

