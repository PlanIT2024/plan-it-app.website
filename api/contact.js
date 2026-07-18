const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { Resend } = require('resend');

const MAX_LEN = {
  name: 120,
  email: 200,
  topic: 80,
  message: 5000,
};

function wrapText(text, font, size, maxWidth) {
  const words = String(text || '').replace(/\r\n/g, '\n').split(/(\s+)/);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (word === '\n') {
      lines.push(current);
      current = '';
      continue;
    }
    const next = current + word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word.trimStart();
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

async function buildContactPdf({ name, email, topic, message, submittedAt }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const margin = 56;
  const pageWidth = 612;
  const pageHeight = 792;
  const contentWidth = pageWidth - margin * 2;
  const lineHeight = 16;
  const purple = rgb(0.498, 0.467, 0.867);
  const dark = rgb(0.1, 0.1, 0.15);
  const muted = rgb(0.35, 0.35, 0.4);

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ensureSpace = (needed) => {
    if (y - needed < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };

  const drawLine = (text, options = {}) => {
    const {
      size = 11,
      weight = font,
      color = dark,
      gap = lineHeight,
    } = options;
    const lines = wrapText(text, weight, size, contentWidth);
    for (const line of lines) {
      ensureSpace(gap);
      page.drawText(line, { x: margin, y, size, font: weight, color });
      y -= gap;
    }
  };

  drawLine('Plan-IT Contact Report', { size: 20, weight: bold, color: purple, gap: 28 });
  drawLine(`Submitted: ${submittedAt}`, { size: 10, color: muted, gap: 22 });

  const fields = [
    ['Name', name],
    ['Email', email],
    ['Topic', topic],
  ];

  for (const [label, value] of fields) {
    drawLine(`${label}:`, { size: 10, weight: bold, color: muted, gap: 14 });
    drawLine(value, { size: 12, weight: font, gap: 20 });
  }

  drawLine('Message:', { size: 10, weight: bold, color: muted, gap: 14 });
  drawLine(message, { size: 12, weight: font, gap: 16 });

  return Buffer.from(await pdfDoc.save());
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const topic = String(body.topic || '').trim();
    const message = String(body.message || '').trim();
    const honeypot = String(body.company || '').trim();

    if (honeypot) {
      return res.status(200).json({ ok: true });
    }

    if (!name || !email || !topic || !message) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (
      name.length > MAX_LEN.name ||
      email.length > MAX_LEN.email ||
      topic.length > MAX_LEN.topic ||
      message.length > MAX_LEN.message
    ) {
      return res.status(400).json({ error: 'One or more fields are too long.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error('RESEND_API_KEY is not configured');
      return res.status(500).json({ error: 'Contact form is not configured yet.' });
    }

    const submittedAt = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const pdfBuffer = await buildContactPdf({
      name,
      email,
      topic,
      message,
      submittedAt,
    });

    const to = process.env.CONTACT_TO_EMAIL || 'support@planitapp.app';
    const from = process.env.CONTACT_FROM_EMAIL || 'Plan-IT <support@planitapp.app>';
    const safeName = name.replace(/[^\w.-]+/g, '_').slice(0, 40);
    const filename = `planit-contact-${safeName}-${Date.now()}.pdf`;

    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: [to],
      replyTo: email,
      subject: `Plan-IT contact: ${topic} — ${name}`,
      html: `
        <p>A new contact form submission was received on planitapp.app.</p>
        <ul>
          <li><strong>Name:</strong> ${escapeHtml(name)}</li>
          <li><strong>Email:</strong> ${escapeHtml(email)}</li>
          <li><strong>Topic:</strong> ${escapeHtml(topic)}</li>
        </ul>
        <p><strong>Message</strong></p>
        <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
        <p>The full report is attached as a PDF.</p>
      `,
      text: [
        'A new contact form submission was received on planitapp.app.',
        '',
        `Name: ${name}`,
        `Email: ${email}`,
        `Topic: ${topic}`,
        '',
        'Message:',
        message,
      ].join('\n'),
      attachments: [
        {
          filename,
          content: pdfBuffer,
        },
      ],
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ error: 'Failed to send your message. Please try again.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact form error:', err);
    return res.status(500).json({ error: 'Failed to send your message. Please try again.' });
  }
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
