// app/api/editData/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sheets, calendar } from '@/lib/google';
import { getEditInstruction } from '@/lib/openai';

/**
 * Webhook de EDIÇÃO para Moveo:
 * 1) Busca histórico completo da conversa (Moveo Analytics GraphQL).
 * 2) Chama IA (getEditInstruction) para extrair a intenção.
 * 3) Executa ação em Google Sheets ou Google Calendar.
 * 4) Retorna no formato Moveo: context.live_instructions + context.session_variables + output.responses
 *
 * ENV esperadas (seu .env):
 * - MOVEO_ANALYTICS_API_KEY
 * - MOVEO_ACCOUNT_ID
 * - GOOGLE_CREDENTIALS_PATH (usada no seu google.ts)
 * - SHEET_ID
 * - SHEET_RANGE (ex.: "Página1!A:D")
 * - (opcional) DEFAULT_TZ (fallback "America/Sao_Paulo")
 */

//
// ================ Config & tipos ================
//
const MOVEO_LOGS_URL = "https://logs.moveo.ai/v1/graphql"; // endpoint Analytics GraphQL
const MOVEO_ACCOUNT_ID = process.env.MOVEO_ACCOUNT_ID!;
const MOVEO_ANALYTICS_API_KEY = process.env.MOVEO_ANALYTICS_API_KEY!;

const SHEET_ID = process.env.SHEET_ID!;
const SHEET_RANGE = (process.env.SHEET_RANGE || "Página1!A:Z")!;
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Sao_Paulo";

type MoveoMessage = {
    event?: string;
    time?: string;
    agent_id?: string | null;
    message?: {
        text?: string | null;
        responses?: Array<{ text?: string | null; type?: string | null }> | null;
    } | null;
};

type Instruction =
    | {
        action:
        | "update_phone"
        | "update_email"
        | "update_name"
        | "update_sheet_field"
        | "create_event"
        | "update_event"
        | "delete_event";
        // Sheets
        new_value?: string;
        field?: string;
        identifier?: { key: string; value: string }; // como localizar a linha
        // Calendar
        event?: {
            eventId?: string;
            summary?: string;
            description?: string;
            location?: string;
            attendees?: string[]; // emails
            start?: string; // ISO
            end?: string; // ISO
            timezone?: string; // IANA
            date?: string; // yyyy-mm-dd (ajuda para busca)
            calendarId?: string; // se seu google.ts aceitar direcionar por e-mail (da planilha)
        };
    }
    | Record<string, any>;

//
// ================ Utilitários ================
//
function onlyDigits(s?: string | null) {
    return (s || "").replace(/\D+/g, "");
}

function normalizeHeader(h: any) {
    return String(h || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");
}

function extractSheetName(range: string): string {
    const idx = range.indexOf("!");
    return idx >= 0 ? range.slice(0, idx) : "Sheet1";
}

function columnNumberToLetter(num: number) {
    let n = num + 1;
    let s = "";
    while (n > 0) {
        const mod = (n - 1) % 26;
        s = String.fromCharCode(65 + mod) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

function buildPlainConversation(messages: MoveoMessage[]): string {
    return messages
        .map((m) => {
            if (m.event === "message:received") {
                return `U: ${m.message?.text ?? ""}`;
            }
            if (m.event === "message:brain_send") {
                const responses = m.message?.responses;
                const joined = Array.isArray(responses)
                    ? responses
                        .map((r: any) => r?.text || (Array.isArray(r?.texts) ? r.texts.join(" ") : ""))
                        .filter(Boolean)
                        .join(" ")
                    : "";
                return joined ? `A: ${joined}` : "";
            }
            return "";
        })
        .filter(Boolean)
        .join("\n");
}

//
// ================ Moveo Analytics: buscar histórico ================
//
async function fetchSessionMessages(sessionId: string): Promise<MoveoMessage[]> {
    const query = `
    query SessionContentV2($sessionId: String) {
        rows: log_session_content_v2(args: { session_id: $sessionId }) {
            messages
            brain_id
            brain_parent_id
            avg_confidence
            brain_version
            channel
            channel_user_id
            desk_id
            end_time
            expired_time
            external_user_id
            integration_id
            is_contained
            is_covered
            is_test
            min_confidence
            participated_brains
            participated_collections
            participated_agents
            rating
            feedback
            session_id
            start_time
            tags
            rule_ids
            total_user_messages
            user_id
            user_name
            user_email
        }
    }
  `;
    const res = await fetch(MOVEO_LOGS_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `apikey ${MOVEO_ANALYTICS_API_KEY}`,
            "X-Moveo-Account-Id": MOVEO_ACCOUNT_ID,
        },
        body: JSON.stringify({ query, variables: { sessionId } }),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Analytics request failed (${res.status}): ${txt}`);
    }
    const json = await res.json();
    const messages: MoveoMessage[] = json?.data?.rows?.[0]?.messages ?? [];
    return messages;
}

//
// ================ Google Sheets helpers ================
//
async function readSheetAll() {
    if (!SHEET_ID) throw new Error("SHEET_ID ausente.");
    const read = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: SHEET_RANGE,
    });
    const values: string[][] = (read.data.values as any) || [];
    return values;
}

function findRowIndexByIdentifier(
    values: string[][],
    headers: string[],
    identifier?: { key: string; value: string },
    fallback: { email?: string; phone?: string; name?: string } = {}
): number {
    const candidates = [];
    if (identifier?.key && identifier?.value) {
        candidates.push({ key: normalizeHeader(identifier.key), value: identifier.value });
    }
    if (fallback.email) candidates.push({ key: "email", value: fallback.email });
    if (fallback.phone) {
        candidates.push({ key: "telefone", value: fallback.phone });
        candidates.push({ key: "phone", value: fallback.phone });
    }
    if (fallback.name) candidates.push({ key: "nome", value: fallback.name });

    for (const cand of candidates) {
        const col = headers.findIndex((h) => h === normalizeHeader(cand.key));
        if (col >= 0) {
            const targetDigits = onlyDigits(cand.value);
            for (let i = 1; i < values.length; i++) {
                const cell = String(values[i]?.[col] ?? "");
                if (headers[col].includes("telefone") || headers[col].includes("phone")) {
                    if (targetDigits && onlyDigits(cell) === targetDigits) return i;
                } else {
                    if (cell.trim().toLowerCase() === String(cand.value).trim().toLowerCase()) return i;
                }
            }
        }
    }
    return -1;
}

function findColumnIndexByField(headers: string[], field?: string): number {
    if (!field) return -1;
    const wanted = normalizeHeader(field);
    let idx = headers.findIndex((h) => h === wanted);
    if (idx >= 0) return idx;

    const alias: Record<string, string[]> = {
        telefone: ["telefone", "phone", "celular", "mobile", "user_phone", "telefone_do_usuario"],
        email: ["email", "e-mail", "mail", "user_email"],
        nome: ["nome", "name", "user_name", "full_name"],
    };
    for (const k of Object.keys(alias)) {
        if (wanted.includes(k)) {
            for (const a of alias[k]) {
                idx = headers.findIndex((h) => h === a);
                if (idx >= 0) return idx;
            }
        }
    }
    return -1;
}

async function updateSheetCell(rowIndex: number, colIndex: number, newValue: string) {
    const sheetName = extractSheetName(SHEET_RANGE);
    const colLetter = columnNumberToLetter(colIndex);
    const rangeA1 = `${sheetName}!${colLetter}${rowIndex + 1}`;
    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: rangeA1,
        valueInputOption: "RAW",
        requestBody: { values: [[newValue]] },
    });
}

async function applySheetUpdate(params: {
    field: string;
    newValue: string;
    identifier?: { key: string; value: string };
    fallbackIdentity: { email?: string; phone?: string; name?: string };
}) {
    const values = await readSheetAll();
    if (!values.length) throw new Error("Planilha vazia ou intervalo inválido.");

    const headers = values[0].map(normalizeHeader);
    const rowIndex = findRowIndexByIdentifier(values, headers, params.identifier, params.fallbackIdentity);
    if (rowIndex < 0) throw new Error("Linha do usuário não encontrada na planilha.");

    const colIndex = findColumnIndexByField(headers, params.field);
    if (colIndex < 0) throw new Error(`Coluna para o campo "${params.field}" não encontrada.`);

    const oldVal = values[rowIndex]?.[colIndex] ?? "";
    await updateSheetCell(rowIndex, colIndex, params.newValue);
    return { row: rowIndex + 1, col: colIndex + 1, old: String(oldVal), updated: params.newValue };
}

//
// ================ Google Calendar helpers (usa seus wrappers se existirem) ================
//
async function createCalendarEvent(ev: {
    summary: string;
    description?: string;
    location?: string;
    attendees?: string[];
    start: string;
    end: string;
    timezone?: string;
    calendarId?: string;
}) {
    const tz = ev.timezone || DEFAULT_TZ;
    const attendees = (ev.attendees || []).map((email) => ({ email }));
    const res = await calendar.events.insert({
        calendarId: ev.calendarId || "primary",
        requestBody: {
            summary: ev.summary,
            description: ev.description,
            location: ev.location,
            attendees,
            start: { dateTime: ev.start, timeZone: tz },
            end: { dateTime: ev.end, timeZone: tz },
        },
    }); // events.insert cria evento. :contentReference[oaicite:3]{index=3}
    return res.data;
}

async function listCalendarEvents(params: { q?: string; timeMin?: string; timeMax?: string; maxResults?: number; calendarId?: string }) {
    const res = await calendar.events.list({
        calendarId: params.calendarId || "primary",
        q: params.q,
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        maxResults: params.maxResults ?? 50,
        singleEvents: true,
        orderBy: "startTime",
    });
    return res.data.items || [];
}

async function patchCalendarEvent(eventId: string, patch: any, calendarId?: string) {
    const res = await calendar.events.patch({
        calendarId: calendarId || "primary",
        eventId,
        requestBody: patch,
    }); // events.patch atualiza campos do evento. :contentReference[oaicite:4]{index=4}
    return res.data;
}
async function deleteCalendarEvent(eventId: string, calendarId?: string) {
    await calendar.events.delete({
        calendarId: calendarId || "primary",
        eventId,
    }); // events.delete remove o evento. :contentReference[oaicite:5]{index=5}
}

//
// ================ Handler principal ================
//
export async function POST(req: NextRequest) {
    console.log("✓ Webhook editData recebido.");
    try {
        const body = await req.json().catch(() => ({}));

        // Extrai sessionId e variáveis úteis
        const sessionId: string | undefined =
            body?.context?.session_id ||
            body?.session_id ||
            body?.context?.$sys_session ||
            body?.context?.["$sys-session"] ||
            body?.["$sys-session"];

        const lastUserMessageRealTime = body.input?.text?.trim() || ""; // Capturamos a mensagem em tempo real

        const sessionVars = {
            user_name:
                body?.context?.session_variables?.user_name ||
                body?.context?.$user?.display_name ||
                "",
            user_email:
                body?.context?.session_variables?.user_email ||
                body?.context?.$user?.email ||
                "",
            user_phone: body?.context?.session_variables?.user_phone || "",
            calendar_email:
                body?.context?.session_variables?.user_email || "",
        };

        // 1) Buscar histórico
        let messages: MoveoMessage[] = [];
        if (sessionId) {
            try {
                messages = await fetchSessionMessages(sessionId);
            } catch (err: any) {
                console.error("✗ Falha ao buscar SessionContentV2:", err?.message);
            }
        } else {
            console.warn("⚠️  Webhook sem session_id.");
        }

        // 2) Construir a conversa a partir do histórico da API
        let conversationFromHistory = buildPlainConversation(messages);

        // ======================== LÓGICA DE DUPLA VERIFICAÇÃO ========================
        // Verificamos se a mensagem em tempo real já não está no final do histórico
        if (lastUserMessageRealTime && !conversationFromHistory.endsWith(`U: ${lastUserMessageRealTime}`)) {
            // Se não estiver, nós a adicionamos para garantir que a IA tenha o contexto mais recente
            conversationFromHistory += `\nU: ${lastUserMessageRealTime}`;
        }
        const conversation = conversationFromHistory.trim();
        // ===========================================================================

        // Se a conversa retornar vazia, paramos a execução e avisamos o usuário.
        if (!conversation || conversation.trim() === '') {
            console.warn("⚠️  Conversa vazia. Pulando a chamada para a IA da OpenAI.");
            const errorMessage = "Desculpe, não consegui recuperar o histórico da conversa para processar seu pedido. Por favor, tente novamente.";

            // Retorna uma resposta controlada para a Moveo
            return NextResponse.json({
                output: {
                    responses: [{ type: "text", texts: [errorMessage] }],
                }
            }, { status: 200 });
        }
        // =======================================================================

        console.log("\n--- HISTÓRICO ENVIADO À IA ---\n");
        console.log(conversation);
        console.log("--------------------------------\n");

        // 2) IA -> instrução
        let instruction: Instruction | null = null;
        try {
            instruction = (await getEditInstruction(conversation, sessionVars.user_phone)) as Instruction;
        } catch (e: any) {
            console.error("✗ Falha ao chamar getEditInstruction:", e?.message);
        }

        const lastUserMsg =
            messages?.slice().reverse().find((m) => m.event === "message:received")?.message?.text || "";
        console.log("\n--- LOG DE EDIÇÃO ---");
        console.log("Última mensagem do usuário:", lastUserMsg);
        console.log("Intenção:", instruction?.action || "error");
        console.log("Payload:", JSON.stringify(instruction, null, 2));

        // 3) Executar a ação
        let outputText = "";
        let liveInstructions = "";
        const sessionPatch: Record<string, any> = {};

        const action = String(instruction?.action || "");
        try {
            switch (action) {
                // ======= SHEETS =======
                case "update_phone": {
                    const newVal = String(instruction?.new_value || "");
                    if (!newVal) throw new Error("new_value ausente.");
                    const res = await applySheetUpdate({
                        field: "telefone",
                        newValue: newVal,
                        identifier: instruction?.identifier,
                        fallbackIdentity: {
                            email: sessionVars.user_email,
                            phone: sessionVars.user_phone,
                            name: sessionVars.user_name,
                        },
                    });
                    outputText = `Pronto, ${sessionVars.user_name || "ok"}! Atualizei seu telefone para ${newVal}.`;
                    liveInstructions =
                        `### Dados do Usuário (atualizados)\n` +
                        `- Nome: ${sessionVars.user_name || "-"}\n` +
                        `- Email: ${sessionVars.user_email || "-"}\n` +
                        `- Telefone: ${newVal}`;
                    sessionPatch.user_phone = newVal;
                    console.log(`✓ Sheets: linha ${res.row}, col ${res.col} (${res.old} -> ${res.updated}).`);
                    break;
                }
                case "update_email": {
                    const newVal = String(instruction?.new_value || "");
                    if (!newVal) throw new Error("new_value ausente.");
                    const res = await applySheetUpdate({
                        field: "email",
                        newValue: newVal,
                        identifier: instruction?.identifier,
                        fallbackIdentity: {
                            email: sessionVars.user_email,
                            phone: sessionVars.user_phone,
                            name: sessionVars.user_name,
                        },
                    });
                    outputText = `Tudo certo! Atualizei seu e-mail para ${newVal}.`;
                    liveInstructions =
                        `### Dados do Usuário (atualizados)\n` +
                        `- Nome: ${sessionVars.user_name || "-"}\n` +
                        `- Email: ${newVal}\n` +
                        `- Telefone: ${sessionVars.user_phone || "-"}`;
                    sessionPatch.user_email = newVal;
                    console.log(`✓ Sheets: linha ${res.row}, col ${res.col} (${res.old} -> ${res.updated}).`);
                    break;
                }
                case "update_name": {
                    const newVal = String(instruction?.new_value || "");
                    if (!newVal) throw new Error("new_value ausente.");
                    const res = await applySheetUpdate({
                        field: "nome",
                        newValue: newVal,
                        identifier: instruction?.identifier,
                        fallbackIdentity: {
                            email: sessionVars.user_email,
                            phone: sessionVars.user_phone,
                            name: sessionVars.user_name,
                        },
                    });
                    outputText = `Nome atualizado para ${newVal}.`;
                    liveInstructions =
                        `### Dados do Usuário (atualizados)\n` +
                        `- Nome: ${newVal}\n` +
                        `- Email: ${sessionVars.user_email || "-"}\n` +
                        `- Telefone: ${sessionVars.user_phone || "-"}`;
                    sessionPatch.user_name = newVal;
                    console.log(`✓ Sheets: linha ${res.row}, col ${res.col} (${res.old} -> ${res.updated}).`);
                    break;
                }
                case "update_sheet_field": {
                    const field = String(instruction?.field || "");
                    const newVal = String(instruction?.new_value || "");
                    if (!field || !newVal) throw new Error("field/new_value ausentes.");
                    const res = await applySheetUpdate({
                        field,
                        newValue: newVal,
                        identifier: instruction?.identifier,
                        fallbackIdentity: {
                            email: sessionVars.user_email,
                            phone: sessionVars.user_phone,
                            name: sessionVars.user_name,
                        },
                    });
                    outputText = `Campo "${field}" atualizado para "${newVal}".`;
                    liveInstructions = `### Atualização de planilha\n- ${field}: ${newVal} (linha ${res.row})`;
                    console.log(`✓ Sheets: linha ${res.row}, col ${res.col} (${res.old} -> ${res.updated}).`);
                    const normalized = normalizeHeader(field);
                    if (["telefone", "phone", "user_phone"].includes(normalized)) sessionPatch.user_phone = newVal;
                    if (["email", "user_email"].includes(normalized)) sessionPatch.user_email = newVal;
                    if (["nome", "name", "user_name"].includes(normalized)) sessionPatch.user_name = newVal;
                    break;
                }

                // ======= CALENDAR =======
                case "create_event": {
                    const ev = instruction?.event || {};
                    if (!ev.start || !ev.end || !ev.summary) {
                        throw new Error("Para create_event: summary, start e end são obrigatórios.");
                    }
                    const created = await createCalendarEvent({
                        summary: ev.summary!,
                        description: ev.description,
                        location: ev.location,
                        attendees: ev.attendees,
                        start: ev.start!,
                        end: ev.end!,
                        timezone: ev.timezone || DEFAULT_TZ,
                        // se seu google.ts aceitar calendarId por e-mail (obtido da planilha), passe aqui:
                        calendarId: ev.calendarId || sessionVars.calendar_email || sessionVars.user_email || undefined,
                    });
                    outputText = `Evento criado: ${created.summary} (${created.id}).`;
                    liveInstructions = `### Agenda\n- Evento criado com sucesso.\n- ID: ${created.id}`;
                    (sessionPatch as any).last_event_id = created.id;
                    break;
                }
                case "update_event": {
                    const ev = instruction?.event || {};
                    let calendarId = ev.calendarId || sessionVars.calendar_email || sessionVars.user_email || undefined;
                    let eventId = ev.eventId;

                    if (!eventId && ev.summary) {
                        const date = ev.date || (ev.start ? ev.start.slice(0, 10) : undefined);
                        const dayStart = date ? new Date(date + "T00:00:00Z").toISOString() : undefined;
                        const dayEnd = date ? new Date(date + "T23:59:59Z").toISOString() : undefined;
                        const matches = await listCalendarEvents({
                            calendarId,
                            q: ev.summary,
                            timeMin: dayStart,
                            timeMax: dayEnd,
                            maxResults: 5,
                        });
                        eventId = matches?.[0]?.id;
                    }
                    if (!eventId) throw new Error("Não foi possível identificar o evento para atualizar.");

                    const patch: any = {};
                    if (ev.summary) patch.summary = ev.summary;
                    if (ev.description) patch.description = ev.description;
                    if (ev.location) patch.location = ev.location;
                    if (ev.start) patch.start = { dateTime: ev.start, timeZone: ev.timezone || DEFAULT_TZ };
                    if (ev.end) patch.end = { dateTime: ev.end, timeZone: ev.timezone || DEFAULT_TZ };

                    const updated = await patchCalendarEvent(eventId, patch, calendarId);
                    outputText = `Evento atualizado: ${updated.summary} (${updated.id}).`;
                    liveInstructions = `### Agenda\n- Evento atualizado com sucesso.\n- ID: ${updated.id}`;
                    (sessionPatch as any).last_event_id = updated.id;
                    break;
                }
                case "delete_event": {
                    const ev = instruction?.event || {};
                    let calendarId = ev.calendarId || sessionVars.calendar_email || sessionVars.user_email || undefined;
                    let eventId = ev.eventId;

                    if (!eventId && ev.summary) {
                        const date = ev.date || undefined;
                        const dayStart = date ? new Date(date + "T00:00:00Z").toISOString() : undefined;
                        const dayEnd = date ? new Date(date + "T23:59:59Z").toISOString() : undefined;
                        const matches = await listCalendarEvents({
                            calendarId,
                            q: ev.summary,
                            timeMin: dayStart,
                            timeMax: dayEnd,
                            maxResults: 5,
                        });
                        eventId = matches?.[0]?.id;
                    }
                    if (!eventId) throw new Error("Não foi possível identificar o evento para excluir.");

                    await deleteCalendarEvent(eventId, calendarId);
                    outputText = `Ok! Evento removido.`;
                    liveInstructions = `### Agenda\n- Evento removido com sucesso.\n- ID: ${eventId}`;
                    (sessionPatch as any).last_event_id = eventId;
                    break;
                }

                default:
                    throw new Error("Ação não reconhecida pela IA.");
            }
        } catch (e: any) {
            outputText =
                "Não consegui identificar ou executar a edição solicitada." +
                (e?.message ? ` Detalhe: ${e.message}` : "");
            liveInstructions = "### Observação\n- Pedido de edição não pôde ser processado.";
            console.error("✗ Execução de ação falhou:", e?.message);
        }

        console.log("Retorno para Moveo:", outputText);
        console.log("--- FIM DO LOG DE EDIÇÃO ---\n");

        return NextResponse.json({
            output: { live_instructions: outputText },
        });
    } catch (error: any) {
        console.error("✗ ERRO no webhook editData:", error?.message);
        return NextResponse.json(
            {
                context: {
                    live_instructions: "### Erro\n- Falha interna ao processar sua solicitação.",
                },
                output: {
                    responses: [
                        { type: "text", texts: ["Erro interno ao processar sua solicitação. Tente novamente."] },
                    ],
                },
            },
            { status: 500 }
        );
    }
}
