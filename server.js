'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { procesarCedula } = require('./processor');
const { procesarOficio } = require('./processor-oficio');

const app  = express();
const PORT = process.env.PORT || 3000;

const TEMPLATE = path.join(__dirname, 'acredita_diligenciamiento.docx');
const TEMPLATE_OFICIO = path.join(__dirname, 'acredita_diligenciamiento_oficio_template.docx');

// ── Static frontend ──────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer: recibir PDF ──────────────────────
const upload = multer({
  dest: path.join(os.tmpdir(), 'uploads'),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo se aceptan archivos PDF'));
  },
});

// ── POST /procesar ───────────────────────────
app.post('/procesar', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún PDF.' });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));

  try {
    const resultado = await procesarCedula(req.file.path, workDir, TEMPLATE);

    // Leer PDF y enviar como descarga
    const pdfBuffer = fs.readFileSync(resultado.pdfPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="acredita_diligenciamiento.pdf"');
    res.setHeader('X-Exp-Nro',   resultado.expNro);
    res.setHeader('X-Caratula',  encodeURIComponent(resultado.caratula));
    res.send(pdfBuffer);

  } catch (err) {
    console.error('[Error]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // Limpiar archivos temporales
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
});

app.post('/procesar-oficio', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún PDF.' });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-oficio-'));
  try {
    const resultado = await procesarOficio(req.file.path, workDir, TEMPLATE_OFICIO);
    const pdfBuffer = fs.readFileSync(resultado.pdfPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="acredita_diligenciamiento_oficio.pdf"');
    res.setHeader('X-Exp-Nro',      resultado.expNro);
    res.setHeader('X-Caratula',     encodeURIComponent(resultado.caratula));
    res.setHeader('X-Destinatario', encodeURIComponent(resultado.destinatario));
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[Error Oficio]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
});

const { cargarEnPjn } = require('./pjn-loader');

app.post('/cargar-pjn', express.json(), async (req, res) => {
  const { pdfPath, pdfUrl, expNro, jurisdiccion, cedulaId, pdfNombre } = req.body;
  if (!expNro || (!pdfPath && !pdfUrl)) {
    return res.status(400).json({ error: 'expNro y pdfPath o pdfUrl son requeridos' });
  }
  try {
    const resultado = await cargarEnPjn({ pdfPath, pdfUrl, expNro, jurisdiccion, pdfNombre, cedulaId });
    res.json(resultado);
  } catch (err) {
    console.error('[/cargar-pjn]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
