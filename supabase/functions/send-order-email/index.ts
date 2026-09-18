import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

type EventRow = {
  id: string;
  order_id: string;
  subscription_id: string;
  event_type: string;
  status: string;
  recipient_email: string;
  attempts: number;
};

type OrderRow = {
  id: string;
  order_number: number;
  branch_id: string;
  table_id: string;
  total: number | string;
  tracking_token: string;
  cancellation_reason: string | null;
  rejection_reason: string | null;
  rejection_note: string | null;
};

const COPY: Record<string, { title: string; message: string }> = {
  ORDER_RECEIVED: { title: "Order received", message: "Your order has been received by the restaurant." },
  ORDER_ACCEPTED: { title: "Order accepted", message: "The restaurant has accepted your order." },
  ORDER_PREPARING: { title: "Order is being prepared", message: "The restaurant has started preparing your order." },
  ORDER_READY: { title: "Order ready", message: "Your order is ready." },
  ORDER_COMPLETED: { title: "Order completed", message: "Your order has been completed." },
  ORDER_CANCELLED: { title: "Order cancelled", message: "Your order has been cancelled." },
  ORDER_REJECTED: { title: "Order rejected", message: "The restaurant could not accept your order." },
};
const EVENT_TYPES = new Set(Object.keys(COPY));

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
  if (!key) {
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}") as Record<string, string>;
      key = keys.default?.trim() || "";
    } catch {
      key = "";
    }
  }
  if (!url || !key) throw new Error("Supabase server credentials are not configured.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// Gateway JWT verification is enabled. Only a verified service_role JWT may dispatch mail.
function requireServiceRole(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Service authorization required.");
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const claims = JSON.parse(atob(b64)) as { role?: string };
    if (claims.role !== "service_role") throw new Error("Service authorization required.");
  } catch {
    throw new Error("Service authorization required.");
  }
}

function escapeHtml(v: string) {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function money(v: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(v);
}

function render(event: EventRow, order: OrderRow, restaurantName: string, restaurantSlug: string, tableCode: string, tableNumber: number) {
  const copy = COPY[event.event_type];
  if (!copy) throw new Error(`Unsupported event type: ${event.event_type}`);
  let message = copy.message;
  if (event.event_type === "ORDER_CANCELLED" && order.cancellation_reason) message += ` Reason: ${order.cancellation_reason}.`;
  if (event.event_type === "ORDER_REJECTED") {
    const reason = order.rejection_note?.trim() || order.rejection_reason?.trim();
    if (reason) message += ` Reason: ${reason}.`;
  }
  const total = Number(order.total);
  const totalText = Number.isFinite(total) ? money(total) : "—";
  const appBase = (Deno.env.get("TABLELY_PUBLIC_APP_URL")?.trim() || "https://www.tablely.in").replace(/\/$/, "");
  const orderUrl = `${appBase}/r/${encodeURIComponent(restaurantSlug)}/table/${encodeURIComponent(tableCode)}/order/${encodeURIComponent(order.tracking_token)}`;
  const badge = event.event_type.replace("ORDER_", "").replaceAll("_", " ");
  const reasonLine = message !== copy.message ? `<div style="font-size:13px;color:#555;margin-top:10px">${escapeHtml(message.replace(copy.message, "").trim())}</div>` : "";
  const cta = orderUrl ? `<div style="margin-top:24px"><a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 18px;border-radius:8px">View order</a></div>` : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#111"><div style="max-width:640px;margin:0 auto;padding:28px 14px"><div style="background:#fff;border:1px solid #e3e3e3;border-radius:14px;overflow:hidden"><div style="padding:22px 24px;border-bottom:1px solid #ececec"><div style="font-size:21px;font-weight:800;letter-spacing:.02em">TABLELY</div><div style="font-size:12px;color:#777;margin-top:4px">Order update</div></div><div style="padding:26px 24px"><div style="display:inline-block;background:#f0f0f0;border-radius:999px;padding:6px 10px;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase">${escapeHtml(badge)}</div><div style="font-size:13px;color:#666;margin-top:16px">${escapeHtml(restaurantName)}</div><h1 style="font-size:28px;line-height:1.2;margin:7px 0 12px">${escapeHtml(copy.title)}</h1><p style="font-size:15px;line-height:1.65;margin:0;color:#222">${escapeHtml(copy.message)}</p>${reasonLine}<div style="background:#f8f8f8;border-radius:11px;padding:17px;margin-top:24px"><div style="font-size:13px;color:#666">Order #${escapeHtml(String(order.order_number))}</div><div style="font-size:14px;margin-top:7px">Table ${escapeHtml(String(tableNumber))}</div><div style="font-size:14px;margin-top:7px">Total ${escapeHtml(totalText)}</div></div>${cta}<p style="font-size:12px;line-height:1.5;color:#777;margin:24px 0 0">This is a transactional update for your TABLELY restaurant order. The View order link is unique to this order.</p></div></div></div></body></html>`;
  const textLines = ["TABLELY", "", restaurantName, copy.title, "", message, "", `Order #${order.order_number}`, `Table ${tableNumber}`, `Total ${totalText}`];
  if (orderUrl) textLines.push("", `View order: ${orderUrl}`);
  textLines.push("", "This is a transactional update for your TABLELY restaurant order.");
  return { subject: `TABLELY — ${copy.title} · Order #${order.order_number}`, html, text: textLines.join("\n") };
}

async function failed(db: ReturnType<typeof adminClient>, id: string, message: string) {
  await db.from("order_email_notification_events").update({ status: "FAILED", error_message: message.slice(0, 1000) }).eq("id", id).eq("status", "SENDING");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ error: "Method not allowed." }, 405);
  try {
    requireServiceRole(req);
    const input = await req.json().catch(() => null) as { event_id?: unknown } | null;
    const eventId = typeof input?.event_id === "string" ? input.event_id.trim() : "";
    if (!/^[0-9a-fA-F-]{36}$/.test(eventId)) return response({ error: "event_id must be a UUID." }, 400);

    const db = adminClient();
    const { data: row, error: lookupError } = await db.from("order_email_notification_events").select("id,order_id,subscription_id,event_type,status,recipient_email,attempts").eq("id", eventId).maybeSingle();
    if (lookupError) { console.error(lookupError); return response({ error: "Could not load email event." }, 500); }
    if (!row) return response({ error: "Email event not found." }, 404);
    const event = row as EventRow;
    if (event.status === "SENT") return response({ ok: true, status: "SENT", eventId, resendEmailId: null, alreadySent: true });
    if (!EVENT_TYPES.has(event.event_type)) return response({ error: `Unsupported event type: ${event.event_type}` }, 400);
    if (!["QUEUED", "FAILED"].includes(event.status)) return response({ error: `Email event is already ${event.status}.` }, 409);

    const { data: claimedRows, error: claimError } = await db.from("order_email_notification_events").update({ status: "SENDING", attempts: event.attempts + 1, last_attempt_at: new Date().toISOString(), error_message: null }).eq("id", event.id).in("status", ["QUEUED", "FAILED"]).select("id,order_id,subscription_id,event_type,status,recipient_email,attempts").limit(1);
    if (claimError) { console.error(claimError); return response({ error: "Could not claim email event." }, 500); }
    const claimed = (claimedRows?.[0] || null) as EventRow | null;
    if (!claimed) return response({ error: "Email event is already being processed." }, 409);

    const { data: subscription, error: subscriptionError } = await db.from("order_email_notification_subscriptions").select("id,order_id,email,enabled").eq("id", claimed.subscription_id).eq("order_id", claimed.order_id).maybeSingle();
    if (subscriptionError || !subscription) { await failed(db, claimed.id, "Email subscription could not be found."); return response({ error: "Email subscription not found." }, 409); }
    if (!(subscription as { enabled: boolean }).enabled) { await failed(db, claimed.id, "Email subscription is disabled."); return response({ error: "Email subscription is disabled." }, 409); }

    const { data: order, error: orderError } = await db.from("orders").select("id,order_number,branch_id,table_id,total,tracking_token,cancellation_reason,rejection_reason,rejection_note").eq("id", claimed.order_id).maybeSingle();
    if (orderError || !order) { await failed(db, claimed.id, "Order could not be loaded."); return response({ error: "Order not found." }, 404); }
    const [{ data: branch, error: branchError }, { data: table, error: tableError }] = await Promise.all([
      db.from("branches").select("id,name,organization_id").eq("id", (order as OrderRow).branch_id).maybeSingle(),
      db.from("tables").select("id,table_number,table_code").eq("id", (order as OrderRow).table_id).maybeSingle(),
    ]);
    if (branchError || !branch) { await failed(db, claimed.id, "Order branch could not be loaded."); return response({ error: "Order branch not found." }, 404); }
    if (tableError || !table) { await failed(db, claimed.id, "Order table could not be loaded."); return response({ error: "Order table not found." }, 404); }

    const { data: org, error: orgError } = await db.from("organizations").select("id,name,slug").eq("id", (branch as { organization_id: string }).organization_id).maybeSingle();
    if (orgError || !org) { await failed(db, claimed.id, "Restaurant could not be loaded."); return response({ error: "Restaurant not found." }, 404); }

    const resendKey = Deno.env.get("RESEND_API_KEY")?.trim();
    const from = Deno.env.get("RESEND_ORDER_EMAIL_FROM")?.trim() || Deno.env.get("RESEND_FROM_EMAIL")?.trim();
    const replyTo = Deno.env.get("RESEND_REPLY_TO_EMAIL")?.trim();
    if (!resendKey || !from) { const msg = "Resend is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL (or RESEND_ORDER_EMAIL_FROM)."; await failed(db, claimed.id, msg); return response({ error: msg }, 503); }

    const rendered = render(
      claimed,
      order as OrderRow,
      String((org as { name: string }).name),
      String((org as { slug: string }).slug),
      String((table as { table_code: string }).table_code),
      Number((table as { table_number: number }).table_number),
    );
    const resendPayload: Record<string, unknown> = { from, to: [claimed.recipient_email], subject: rendered.subject, html: rendered.html, text: rendered.text };
    if (replyTo) resendPayload.reply_to = replyTo;

    let resendResponse: Response;
    try {
      resendResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json", "Idempotency-Key": `tablely-order-email/${claimed.id}` },
        body: JSON.stringify(resendPayload),
      });
    } catch (err) {
      await failed(db, claimed.id, err instanceof Error ? err.message : "Network error while contacting Resend.");
      return response({ error: "Could not reach Resend." }, 502);
    }

    const resendBody = await resendResponse.json().catch(() => null) as { id?: string; message?: string } | null;
    if (!resendResponse.ok) {
      const msg = typeof resendBody?.message === "string" ? `Resend: ${resendBody.message}` : `Resend returned HTTP ${resendResponse.status}.`;
      await failed(db, claimed.id, msg);
      return response({ error: "Resend rejected the email.", details: msg }, 502);
    }
    const resendEmailId = typeof resendBody?.id === "string" ? resendBody.id : null;
    if (!resendEmailId) { const msg = "Resend accepted the request but did not return an email id."; await failed(db, claimed.id, msg); return response({ error: msg }, 502); }

    const { error: saveError } = await db.from("order_email_notification_events").update({ status: "SENT", resend_email_id: resendEmailId, sent_at: new Date().toISOString(), error_message: null }).eq("id", claimed.id).eq("status", "SENDING");
    if (saveError) {
      console.error(saveError);
      return response({ ok: true, status: "SENT", eventId: claimed.id, resendEmailId, warning: "Resend accepted the email but the database status update failed." }, 202);
    }
    return response({ ok: true, status: "SENT", eventId: claimed.id, resendEmailId, alreadySent: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    console.error("send-order-email", err);
    return response({ error: message }, message.includes("Service authorization required") ? 403 : 500);
  }
});
