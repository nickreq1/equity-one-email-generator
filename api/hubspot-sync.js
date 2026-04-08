function splitName(fullName = "") {
  const n = String(fullName || "").trim();
  if (!n) return { firstname: "", lastname: "" };
  const parts = n.split(/\s+/);
  if (parts.length === 1) return { firstname: parts[0], lastname: "" };
  return { firstname: parts[0], lastname: parts.slice(1).join(" ") };
}

async function hsFetch(url, { token, method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${JSON.stringify(json)}`);
  return json;
}

async function findContactIdByEmail(token, email) {
  const json = await hsFetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    token,
    method: "POST",
    body: {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email"]
    }
  });
  return json.results?.[0]?.id || null;
}

async function upsertContact(token, { clientEmail, clientName }) {
  const existingId = await findContactIdByEmail(token, clientEmail);
  const { firstname, lastname } = splitName(clientName);

  if (!existingId) {
    const created = await hsFetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      token,
      method: "POST",
      body: {
        properties: {
          email: clientEmail,
          ...(firstname ? { firstname } : {}),
          ...(lastname ? { lastname } : {})
        }
      }
    });
    return created.id;
  }

  if (clientName) {
    await hsFetch(`https://api.hubapi.com/crm/v3/objects/contacts/${existingId}`, {
      token,
      method: "PATCH",
      body: {
        properties: {
          ...(firstname ? { firstname } : {}),
          ...(lastname ? { lastname } : {})
        }
      }
    });
  }

  return existingId;
}

async function ownerIdByEmail(token, brokerEmail) {
  if (!brokerEmail) return null;

  const res = await fetch("https://api.hubapi.com/owners/v2/owners?email=" + encodeURIComponent(brokerEmail), {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) return null;

  const json = await res.json().catch(() => null);
  if (Array.isArray(json) && json.length) return json[0].id;
  if (json?.id) return json.id;
  return null;
}

async function listAssociatedDealIds(token, contactId) {
  const assoc = await hsFetch(`https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`, {
    token
  });
  return (assoc.results || []).map(r => String(r.toObjectId));
}

async function batchReadDeals(token, dealIds) {
  if (!dealIds.length) return [];
  const json = await hsFetch("https://api.hubapi.com/crm/v3/objects/deals/batch/read", {
    token,
    method: "POST",
    body: {
      properties: ["dealstage", "pipeline", "hs_is_closed", "hs_lastmodifieddate", "dealname"],
      inputs: dealIds.map(id => ({ id }))
    }
  });
  return json.results || [];
}

async function findOpenQuoteDealForContact(token, contactId, { pipelineId, quoteStageId }) {
  const dealIds = await listAssociatedDealIds(token, contactId);
  if (!dealIds.length) return null;

  const deals = await batchReadDeals(token, dealIds);

  const quoteDeals = deals.filter(d => {
    const isClosed = String(d.properties?.hs_is_closed).toLowerCase() === "true";
    if (isClosed) return false;
    if (pipelineId && String(d.properties?.pipeline) !== String(pipelineId)) return false;
    return String(d.properties?.dealstage) === String(quoteStageId);
  });

  if (!quoteDeals.length) return null;

  quoteDeals.sort((a, b) =>
    Number(b.properties?.hs_lastmodifieddate || 0) - Number(a.properties?.hs_lastmodifieddate || 0)
  );

  return quoteDeals[0].id;
}

async function createDeal(token, { dealname, pipelineId, quoteStageId, ownerId }) {
  const deal = await hsFetch("https://api.hubapi.com/crm/v3/objects/deals", {
    token,
    method: "POST",
    body: {
      properties: {
        dealname,
        ...(pipelineId ? { pipeline: String(pipelineId) } : {}),
        ...(quoteStageId ? { dealstage: String(quoteStageId) } : {}),
        ...(ownerId ? { hubspot_owner_id: String(ownerId) } : {})
      }
    }
  });
  return deal.id;
}

async function updateDeal(token, dealId, { dealname, ownerId }) {
  await hsFetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
    token,
    method: "PATCH",
    body: {
      properties: {
        ...(dealname ? { dealname } : {}),
        ...(ownerId ? { hubspot_owner_id: String(ownerId) } : {})
      }
    }
  });
}

async function associateDealToContact(token, dealId, contactId) {
  await hsFetch(
    `https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/contacts/${contactId}/deal_to_contact`,
    { token, method: "PUT" }
  );
}

async function createNote(token, noteBody) {
  const note = await hsFetch("https://api.hubapi.com/crm/v3/objects/notes", {
    token,
    method: "POST",
    body: {
      properties: {
        hs_note_body: noteBody,
        hs_timestamp: Date.now()
      }
    }
  });
  return note.id;
}

async function associateNoteToContact(token, noteId, contactId) {
  await hsFetch(
    `https://api.hubapi.com/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`,
    { token, method: "PUT" }
  );
}

async function associateNoteToDeal(token, noteId, dealId) {
  await hsFetch(
    `https://api.hubapi.com/crm/v4/objects/notes/${noteId}/associations/deals/${dealId}/note_to_deal`,
    { token, method: "PUT" }
  );
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    const pipelineId = process.env.HUBSPOT_DEAL_PIPELINE_ID || ""; // optional but recommended
    const quoteStageId = process.env.HUBSPOT_DEALSTAGE_QUOTE || ""; // required

    if (!token) return res.status(500).json({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" });
    if (!quoteStageId) return res.status(500).json({ error: "Missing HUBSPOT_DEALSTAGE_QUOTE (Quote stage id)" });

    const {
      clientName,
      clientEmail,
      brokerEmail,
      template,
      subject,
      text,
      amountRaw,
      borrower,
      securityProperty,
      p1SecurityProperty,
      p2SecurityProperty
    } = req.body || {};

    if (!clientEmail) return res.status(400).json({ error: "clientEmail is required" });

    const contactId = await upsertContact(token, { clientEmail, clientName });
    const ownerId = await ownerIdByEmail(token, brokerEmail);

    // Deal name = Address
    // - two_properties: use Property 1 address
    // - otherwise: use single securityProperty
    // - fallback to email
    const singleAddr = String(securityProperty || "").trim();
    const p1Addr = String(p1SecurityProperty || "").trim();
    const p2Addr = String(p2SecurityProperty || "").trim();

    let dealname = singleAddr || clientEmail;
    if (String(template) === "two_properties") {
      dealname = p1Addr || singleAddr || clientEmail;
    }

    const existingQuoteDealId = await findOpenQuoteDealForContact(token, contactId, {
      pipelineId: pipelineId || null,
      quoteStageId
    });

    let dealId, dealMode;
    if (existingQuoteDealId) {
      dealId = existingQuoteDealId;
      dealMode = "updated_existing_quote_deal";
      await updateDeal(token, dealId, { dealname, ownerId });
    } else {
      dealId = await createDeal(token, { dealname, pipelineId, quoteStageId, ownerId });
      dealMode = "created_new_quote_deal";
      await associateDealToContact(token, dealId, contactId);
    }

    const noteBody =
      `Subject: ${subject || "FINANCE QUOTE"}\n` +
      `Template: ${template || ""}\n` +
      (brokerEmail ? `Broker email: ${brokerEmail}\n` : "") +
      (amountRaw ? `Amount (raw): ${amountRaw}\n` : "") +
      (borrower ? `Borrower: ${borrower}\n` : "") +
      (singleAddr ? `Address: ${singleAddr}\n` : "") +
      (String(template) === "two_properties"
        ? `Property 1: ${p1Addr}\nProperty 2: ${p2Addr}\n`
        : "") +
      "\n----- GENERATED EMAIL (TEXT) -----\n" +
      (text || "");

    const noteId = await createNote(token, noteBody);

    // Associate note to BOTH contact and deal
    await associateNoteToContact(token, noteId, contactId);
    await associateNoteToDeal(token, noteId, dealId);

    res.status(200).json({ ok: true, contactId, dealId, dealMode, noteId, ownerId: ownerId || "" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
