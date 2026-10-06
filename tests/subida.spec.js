import { test, chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ==================== LEE LA CONFIG GENERADA POR LA INTERFAZ ====================
const configPath = path.join(ROOT, 'config_actual.json');
if (!fs.existsSync(configPath)) {
  throw new Error('No se encontró config_actual.json. Inicia el proceso desde la interfaz web en http://localhost:3000');
}
const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const LOGIN_URL         = CONFIG.url;
const USUARIO           = CONFIG.usuario;
const CLAVE             = CONFIG.clave;
const MOSTRAR_NAVEGADOR = CONFIG.mostrarNavegador !== false;
const IMAGES_DIR        = CONFIG.carpeta; // ya viene como ruta absoluta desde el servidor

// ==================== CONFIGURACIÓN ====================
const RESTART_EVERY        = 40;
const T                    = 8000;
const REINTENTOS_POR_IMAGEN = 2;
const RESUMEN_CADA         = 100;

const PROGRESS_FILE = path.join(ROOT, 'progreso_subida.json');
const LOG_FILE      = path.join(ROOT, `log_subida_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
const CSV_FALLIDOS  = path.join(ROOT, 'fallidos_final.csv');

// ==================== UTILIDADES ====================
function log(mensaje) {
  console.log(mensaje);
  fs.appendFileSync(LOG_FILE, mensaje + '\n');
}

function formatearDuracion(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

function cargarProgreso() {
  return fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'))
    : { completados: [] };
}

function guardarProgreso(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function codigoAPatronFlexible(codigo) {
  const esc = codigo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc.replace(/[_/]/g, '[_/]')}$`);
}

// ==================== SESIÓN ====================
async function abrirSesion(browser) {
   const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page    = await context.newPage();
  // Aplica zoom del 90% a nivel de página
  await page.addInitScript(() => {
    document.documentElement.style.zoom = '0.9';
  });
  await page.goto(LOGIN_URL);
  await page.getByRole('textbox', { name: 'Seleccione al usuario' }).fill(USUARIO, { timeout: T });
  await page.getByRole('textbox', { name: 'Password' }).fill(CLAVE, { timeout: T });
  await page.getByRole('button',  { name: '🏖️ Acceder' }).click({ timeout: T });
  await page.getByRole('link',    { name: 'Inventarios' }).first().click({ timeout: T });
  await page.getByRole('link',    { name: 'Productos' }).click({ timeout: T });
  await page.waitForTimeout(2000);

  return { context, page };
}

// ==================== MODALES ====================
async function cerrarModalesAbiertos(page) {
  const modal = page.locator('.modal.show, [id$="__BV_modal_outer_"]');
  if (await modal.count() > 0) {
    log(`⚠️ Modal detectado. Cerrando...`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    if (await modal.count() > 0) {
      const btn = page.locator('.modal.show button.close, .modal.show [aria-label="Close"]').first();
      if (await btn.count() > 0) await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

// ==================== BUSCADOR ====================
async function limpiarYEscribir(page, codigo) {
  const sb = page.getByRole('searchbox', { name: 'Buscar..' });
  await sb.waitFor({ state: 'visible', timeout: T });
  await sb.click({ timeout: T });

  await sb.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    setter.call(el, v);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, codigo);

  await page.waitForTimeout(300);

  const val = await sb.inputValue();
  if (val !== codigo) throw new Error(`Buscador no quedó con "${codigo}", tiene "${val}"`);
  await page.keyboard.press('Enter');
}

// ==================== PROCESAR IMAGEN ====================
async function procesarImagen(page, file) {
  const filePath       = path.join(IMAGES_DIR, file);
  const codigoProducto = file.replace(/\.[^/.]+$/, '');

  await cerrarModalesAbiertos(page);
  await limpiarYEscribir(page, codigoProducto);

  const resultado = page.getByText(codigoAPatronFlexible(codigoProducto)).first();
  await resultado.waitFor({ state: 'visible', timeout: T });
  await resultado.click({ timeout: T });

  await page.getByRole('button', { name: 'EDITAR' }).click({ timeout: T });
  await page.getByRole('tab',    { name: 'IMÁGENES' }).click({ timeout: T });

  if (await page.locator('input[type="file"]').count() === 0)
    throw new Error('No se encontró input[type="file"] en la página.');

  await page.locator('input[type="file"]').first().setInputFiles(filePath, { timeout: T });
  await page.waitForTimeout(500);
  await page.locator('img').last().waitFor({ state: 'visible', timeout: T }).catch(() => {
    log(`⚠️ Sin vista previa para ${codigoProducto}`);
  });

  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' && r.status() < 400, { timeout: T }).catch(() => null),
    page.getByRole('button', { name: 'Guardar' }).click({ timeout: T }),
  ]);
  if (!response) log(`⚠️ Sin respuesta de red al guardar ${codigoProducto}`);

  await page.waitForTimeout(1500);

  const closeBtn = page.getByRole('button', { name: 'Close' });
  if (await closeBtn.count() > 0) await closeBtn.click({ timeout: T }).catch(() => {});
  await page.waitForTimeout(800);

  if (await page.locator('.modal.show, [id$="__BV_modal_outer_"]').count() > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  return codigoProducto;
}

// ==================== TEST PRINCIPAL ====================
test('Automatización: Carga masiva de imágenes SIESAM', async () => {
  test.setTimeout(0);

  const inicio = Date.now();
  const files  = fs.readdirSync(IMAGES_DIR)
    .filter(f => f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.jpeg'));

  log(`📸 ${files.length} imágenes encontradas en: ${IMAGES_DIR}`);
  log(`🖥️  Navegador: ${MOSTRAR_NAVEGADOR ? 'visible' : 'minimizado'}`);
  log(`📝 Log: ${LOG_FILE}`);

  const progreso    = cargarProgreso();
  const completados = new Set(progreso.completados);
  const pendientes  = files.filter(f => !completados.has(f.replace(/\.[^/.]+$/, '')));

  log(`⏭️  Ya completados: ${completados.size} | 🔜 Pendientes: ${pendientes.length}`);

  const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: MOSTRAR_NAVEGADOR
    ? []
    : ['--window-position=-32000,-32000', '--window-size=1440,900'],
});

  let { context, page } = await abrirSesion(browser);

  let crasheo = false;
  page.on('crash', () => { log('💥 La página crasheó.'); crasheo = true; });

  let desdeReinicio = 0, totalProcesadas = 0, exitosasTramo = 0;
  const fallidosFinal = [];

  for (const file of pendientes) {
    const codigo = file.replace(/\.[^/.]+$/, '');
    log(`🚀 Procesando: ${codigo}`);

    let exito = false, ultimoError = null;

    for (let intento = 1; intento <= REINTENTOS_POR_IMAGEN && !exito; intento++) {
      try {
        await procesarImagen(page, file);
        progreso.completados.push(codigo);
        guardarProgreso(progreso);
        log(`✅ ${codigo} completado.`);
        desdeReinicio++; exitosasTramo++; exito = true;

      } catch (err) {
        ultimoError = err;
        const esCrash = crasheo || /crash/i.test(err.message);
        log(`❌ Intento ${intento}/${REINTENTOS_POR_IMAGEN} falló para ${codigo}: ${err.message}`);

        if (esCrash) {
          log('🔄 Recreando sesión tras crash...');
          crasheo = false;
          await context.close().catch(() => {});
          ({ context, page } = await abrirSesion(browser));
          page.on('crash', () => { log('💥 La página crasheó.'); crasheo = true; });
          desdeReinicio = 0;
        } else {
          await page.screenshot({ path: path.join(ROOT, `error_${codigo}_i${intento}.png`) }).catch(() => {});
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(1000);
        }
      }
    }

    if (!exito) fallidosFinal.push({ codigo, error: ultimoError?.message || 'desconocido' });

    totalProcesadas++;

    if (totalProcesadas % RESUMEN_CADA === 0) {
      const elapsed   = Date.now() - inicio;
      const restantes = pendientes.length - totalProcesadas;
      const estimado  = (elapsed / totalProcesadas) * restantes;
      log(`\n📊 ----- RESUMEN PARCIAL (${totalProcesadas}/${pendientes.length}) -----`);
      log(`   ✅ Exitosas en este tramo: ${exitosasTramo}`);
      log(`   ❌ Fallidas en este tramo: ${RESUMEN_CADA - exitosasTramo}`);
      log(`   ⏱️  Transcurrido: ${formatearDuracion(elapsed)}`);
      log(`   📈 Estimado restante: ${formatearDuracion(estimado)} (${restantes} pendientes)`);
      log(`------------------------------------------------\n`);
      exitosasTramo = 0;
    }

    if (desdeReinicio >= RESTART_EVERY) {
      log(`♻️  Reinicio preventivo tras ${RESTART_EVERY} imágenes...`);
      await context.close().catch(() => {});
      ({ context, page } = await abrirSesion(browser));
      page.on('crash', () => { log('💥 La página crasheó.'); crasheo = true; });
      desdeReinicio = 0;
    }
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const duracion = Date.now() - inicio;
  log(`\n===== RESUMEN FINAL =====`);
  log(`✅ Total completados: ${progreso.completados.length}`);
  log(`❌ Fallidos en esta corrida: ${fallidosFinal.length}`);
  log(`⏱️  Duración total: ${formatearDuracion(duracion)}`);

  if (fallidosFinal.length > 0) {
    const csv = 'codigo,error\n' + fallidosFinal
      .map(f => `"${f.codigo}","${f.error.replace(/"/g, '""')}"`)
      .join('\n');
    fs.writeFileSync(CSV_FALLIDOS, csv);
    log(`📄 Fallidos exportados a: ${CSV_FALLIDOS}`);
  }
});