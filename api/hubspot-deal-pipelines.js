export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (!token) return res.status(500).json({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" });

    const r = await fetch("https://api.hubapi.com/crm/v3/pipelines/deals", {
      headers: { Authorization: `Bearer ${token}` }
    });

    const json = await r.json();
    if (!r.ok) return res.status(r.status).json(json);

    const out = (json.results || []).map(p => ({
      pipelineId: p.id,
      pipelineLabel: p.label,
      stages: (p.stages || []).map(s => ({
        stageId: s.id,
        stageLabel: s.label
      }))
    }));

    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
