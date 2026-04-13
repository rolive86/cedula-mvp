'use strict';

const { chromium } = require('playwright');

const SSO_URL =
  'https://sso.pjn.gov.ar/auth/realms/pjn/protocol/openid-connect/auth' +
  '?client_id=pjn-portal' +
  '&redirect_uri=https%3A%2F%2Fportalpjn.pjn.gov.ar%2Fauth%2Fcallback' +
  '&response_type=code&scope=openid';

async function cargarEnPjn({ pdfPath, expNro, jurisdiccion, pdfNombre, cedulaId }) {
  const usuario  = process.env.PJN_USUARIO;
  const password = process.env.PJN_PASSWORD;

  if (!usuario || !password) {
    throw new Error('PJN_USUARIO o PJN_PASSWORD no configurados en variables de entorno');
  }

  const [numero, anio] = (expNro || '').split('/');
  if (!numero || !anio) throw new Error('expNro inválido: ' + expNro);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext();
  const page    = await context.newPage();

  try {
    // 1. Login SSO
    await page.goto(SSO_URL);
    await page.getByRole('textbox', { name: 'Usuario' }).fill(usuario);
    await page.getByRole('textbox', { name: 'Contraseña' }).fill(password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await page.waitForURL('**/portalpjn.pjn.gov.ar/**', { timeout: 30000 });

    // 2. Ir al inicio
    await page.goto('https://portalpjn.pjn.gov.ar/inicio');
    await page.waitForLoadState('networkidle', { timeout: 20000 });

    // 3. Abrir formulario nuevo escrito (popup)
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.locator('div:nth-child(6) > .MuiButtonBase-root').click(),
    ]);
    await popup.getByRole('menuitem', { name: 'Nuevo' }).click();
    await popup.waitForLoadState('networkidle', { timeout: 20000 });

    // 4. Paso 1: Jurisdicción
    await popup.getByRole('combobox').click();
    await popup.getByRole('option', { name: new RegExp(jurisdiccion, 'i') }).first().click();

    await popup.getByRole('spinbutton', { name: /número/i }).fill(numero);
    await popup.getByRole('spinbutton', { name: /año/i }).fill(anio);
    await popup.getByRole('button', { name: 'Siguiente' }).click();

    // 5. Paso 2: Seleccionar expediente (no incidente)
    await popup.waitForSelector('li[role="option"]', { timeout: 15000 });
    const exps = await popup.locator('li[role="option"]').all();
    let elegido = false;
    for (const exp of exps) {
      const txt = await exp.textContent();
      if (!txt.match(/\/\d{4}\/\d+/)) { await exp.click(); elegido = true; break; }
    }
    if (!elegido) await exps[0].click();
    await popup.getByRole('button', { name: 'Siguiente' }).click();

    // 6. Paso 3: Destinatario
    await popup.waitForSelector('li[role="option"]', { timeout: 10000 });
    await popup.locator('li[role="option"]').first().click();
    await popup.getByRole('button', { name: 'Siguiente' }).click();

    // 7. Paso 4: Adjuntos
    // Tipo ESCRITO
    await popup.locator('input[role="combobox"]').click();
    await popup.waitForSelector('li[role="option"]', { timeout: 5000 });
    await popup.getByRole('option', { name: 'ESCRITO', exact: true }).click();

    // Subir PDF
    const [fileChooser] = await Promise.all([
      popup.waitForEvent('filechooser'),
      popup.getByRole('button', { name: 'Seleccionar' }).click(),
    ]);
    await fileChooser.setFiles(pdfPath);

    // Descripción
    await popup.waitForSelector('[role="dialog"] input[type="text"]', { timeout: 8000 });
    const inputDesc = popup.locator('[role="dialog"] input[type="text"]').first();
    await inputDesc.fill('Acredita Diligenciamiento Cedula');

    // Retry si aparece error de clave de adjunto
    await popup.waitForTimeout(800);
    const errorAdj = await popup.locator('text=clave de adjunto').count();
    if (errorAdj > 0) {
      console.log('[PJN] Retry: error clave de adjunto, reintentando descripción...');
      await inputDesc.clear();
      await inputDesc.fill('Acredita Diligenciamiento Cedula');
      await popup.waitForTimeout(500);
    }

    await popup.getByRole('button', { name: 'Aceptar' }).click();
    await popup.getByRole('button', { name: 'Siguiente' }).click();

    // 8. Paso 5: Enviar
    await popup.waitForSelector('text=Verifique los datos', { timeout: 10000 });
    await popup.getByRole('button', { name: 'Enviar' }).click();
    await popup.waitForTimeout(3000);

    console.log('[PJN] Carga exitosa para cédula:', cedulaId);
    return { ok: true };

  } catch (err) {
    console.error('[PJN] Error en carga:', err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { cargarEnPjn };
