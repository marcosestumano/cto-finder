export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { image, mediaType = 'image/jpeg' } = req.body
  if (!image) return res.status(400).json({ error: 'Imagem não fornecida' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' })

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: image },
            },
            {
              type: 'text',
              text: `Esta é uma foto de uma caixa de fibra óptica (CTO) de telecomunicações.
Extraia APENAS os seguintes campos visíveis na etiqueta ou corpo da caixa:
- area_cabo: código da área/cabo (ex: "IPFH01", "IPFH02", "ABCD01") — geralmente letras maiúsculas seguidas de números
- sp: número do SP (ex: "01", "02") — apenas o número, sem "SP:"
- sec: intervalo do SEC (ex: "01-08", "09-16") — com o hífen

Responda SOMENTE com JSON válido, sem texto extra:
{"area_cabo": "...", "sp": "...", "sec": "..."}

Se algum campo não estiver visível ou legível, use null para ele.`,
            },
          ],
        }],
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return res.status(500).json({ error: 'Erro na API Anthropic: ' + err })
    }

    const data  = await response.json()
    const text  = data.content?.[0]?.text?.trim() || ''

    // Extrai JSON mesmo se vier com texto ao redor
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return res.json({ area_cabo: null, sp: null, sec: null })

    const parsed = JSON.parse(match[0])
    return res.json({
      area_cabo: parsed.area_cabo || null,
      sp:        parsed.sp        || null,
      sec:       parsed.sec       || null,
    })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
