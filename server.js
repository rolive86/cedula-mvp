'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { procesarCedula } = require('./processor');

const app  = express();
const PORT = process.env.PORT || 3000;

const TEMPLATE = path.join(__dirname, 'acredita_diligenciamiento.docx');

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

const { cargarEnPjn } = require('./pjn-loader');

app.post('/cargar-pjn', express.json(), async (req, res) => {
  const { pdfPath, expNro, jurisdiccion, cedulaId, pdfNombre } = req.body;
  if (!pdfPath || !expNro) {
    return res.status(400).json({ error: 'pdfPath y expNro son requeridos' });
  }
  try {
    const resultado = await cargarEnPjn({ pdfPath, expNro, jurisdiccion, pdfNombre, cedulaId });
    res.json(resultado);
  } catch (err) {
    console.error('[/cargar-pjn]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
