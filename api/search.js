export default function handler(req, res) {
  const { q, lang } = req.query;
  res.status(200).json({ message: `You searched for ${q} in ${lang}` });
}
