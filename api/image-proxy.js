// Vercel serverless image proxy for REALGX canvas exports.
// Only trusted image hosts are accepted to prevent arbitrary URL fetching.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const raw = typeof req.query?.url === 'string' ? req.query.url : '';
    if (!raw || raw.length > 4096) return res.status(400).json({ error: 'A valid image URL is required.' });

    const source = new URL(raw);
    const allowedHosts = new Set([
      'i.ibb.co',
      'images.unsplash.com',
      'dhrbmkwijciwpzkwexzq.supabase.co'
    ]);
    if (source.protocol !== 'https:' || !allowedHosts.has(source.hostname) || source.username || source.password) {
      return res.status(403).json({ error: 'This image host is not allowed.' });
    }

    const upstream = await fetch(source.toString(), {
      headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
      redirect: 'follow'
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Unable to retrieve the wallpaper image.' });

    const finalUrl = new URL(upstream.url);
    if (finalUrl.protocol !== 'https:' || !allowedHosts.has(finalUrl.hostname)) {
      return res.status(403).json({ error: 'Image redirect destination is not allowed.' });
    }

    const type = (upstream.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!type.startsWith('image/')) return res.status(415).json({ error: 'The requested resource is not an image.' });

    const declaredLength = Number(upstream.headers.get('content-length') || 0);
    if (declaredLength > 32 * 1024 * 1024) return res.status(413).json({ error: 'Image exceeds the 32 MB export limit.' });

    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > 32 * 1024 * 1024) return res.status(413).json({ error: 'Image exceeds the 32 MB export limit.' });

    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(bytes);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid image URL or image fetch failed.' });
  }
};
