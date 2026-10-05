import { test, expect, chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// ==================== CONFIGURACIÓN ====================
const LOGIN_URL = '<URL_SISTEMA>';
const USUARIO = '<USUARIO>';
const CLAVE = '<CLAVE>';
const RESTART_EVERY = 40;
const T = 8000;
const REINTENTOS_POR_IMAGEN = 2;
const RESUMEN_CADA = 100;

const PROGRESS_FILE = path.join(process.cwd(), 'progreso_subida.json');
const LOG_FILE = path.join(process.cwd(), `log_subida_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
const CSV_FALLIDOS = path.join(process.cwd(), 'fallidos_final.csv');

// ==================== LOG A ARCHIVO Y CONSOLA ====================
function log(mensaje) {
  console.log(mensaje);
  fs.appendFileSync(LOG_FILE, mensaje + '\n');
}

function formatearDuracion(ms) {
  const totalSeg = Math.floor(ms / 1000);
  const horas = Math.floor(totalSeg / 3600);
  const min = Math.floor((totalSeg % 3600) / 60);
  const seg = totalSeg % 60;
  return `${horas}h ${min}m ${seg}s`;
}

// ==================== PROGRESO PERSISTENTE ====================
function cargarProgreso() {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { completados: [] };
}

function guardarProgreso(progreso) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progreso, null, 2));
}

// ==================== PATRÓN FLEXIBLE PARA _ Y / ====================
function codigoAPatronFlexible(codigo) {
  const escapado = codigo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexible = escapado.replace(/[_/]/g, '[_/]');
  return new RegExp(`^${flexible}$`);
}

// ==================== ABRIR SESIÓN ====================
async function abrirSesion(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(LOGIN_URL);
  await page.getByRole('textbox', { name: 'Seleccione al usuario' }).fill(USUARIO, { timeout: T });
  await page.getByRole('textbox', { name: 'Password' }).fill(CLAVE, { timeout: T });
  await page.getByRole('button', { name: '🏖️ Acceder' }).click({ timeout: T });

  await page.getByRole('link', { name: 'Inventarios' }).first().click({ timeout: T });
  await page.getByRole('link', { name: 'Productos' }).click({ timeout: T });
  await page.waitForTimeout(2000);

  return { context, page };
}

// ==================== CERRAR MODALES RESIDUALES ====================
async function cerrarModalesAbiertos(page) {
  const modalAbierto = page.locator('.modal.show, [id$="__BV_modal_outer_"]');
  const count = await modalAbierto.count();

  if (count > 0) {
    log(`⚠️ Se detectó un modal abierto (${count}). Cerrando con Escape...`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const sigueAbierto = await page.locator('.modal.show, [id$="__BV_modal_outer_"]').count();
    if (sigueAbierto > 0) {
      const botonCerrar = page.locator('.modal.show button.close, .modal.show [aria-label="Close"]').first();
      if (await botonCerrar.count() > 0) {
        await botonCerrar.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  }
}

// ==================== LIMPIAR Y ESCRIBIR EN BUSCADOR ====================
async function limpiarYEscribir(page, codigoProducto) {
  const searchBox = page.getByRole('searchbox', { name: 'Buscar..' });
  await searchBox.waitFor({ state: 'visible', timeout: T });
  await searchBox.click({ timeout: T });

  await searchBox.evaluate((el, nuevoValor) => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));

    nativeInputValueSetter.call(el, nuevoValor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, codigoProducto);

  await page.waitForTimeout(300);

  const valorFinal = await searchBox.inputValue();
  if (valorFinal !== codigoProducto) {
    throw new Error(`El buscador no quedó con el valor esperado. Tiene: "${valorFinal}"`);
  }

  await page.keyboard.press('Enter');
}

// ==================== PROCESAR UNA IMAGEN ====================
async function procesarImagen(page, imagesDir, file) {
  const filePath = path.join(imagesDir, file);
  const codigoProducto = file.replace(/\.[^/.]+$/, "");

  await cerrarModalesAbiertos(page);
  await limpiarYEscribir(page, codigoProducto);

  const resultado = page.getByText(codigoAPatronFlexible(codigoProducto)).first();
  await resultado.waitFor({ state: 'visible', timeout: T });
  await resultado.click({ timeout: T });

  await page.getByRole('button', { name: 'EDITAR' }).click({ timeout: T });
  await page.getByRole('tab', { name: 'IMÁGENES' }).click({ timeout: T });

  const fileInputCount = await page.locator('input[type="file"]').count();
  if (fileInputCount === 0) {
    throw new Error('No se encontró ningún input[type="file"] en la página.');
  }

  await page.locator('input[type="file"]').first().setInputFiles(filePath, { timeout: T });

  await page.waitForTimeout(500);
  const preview = page.locator('img').last();
  await preview.waitFor({ state: 'visible', timeout: T }).catch(() => {
    log(`⚠️ No se detectó vista previa de imagen para ${codigoProducto}`);
  });

  const [response] = await Promise.all([
    page.waitForResponse(resp => resp.request().method() === 'POST' && resp.status() < 400, { timeout: T }).catch(() => null),
    page.getByRole('button', { name: 'Guardar' }).click({ timeout: T }),
  ]);

  if (!response) {
    log(`⚠️ No se detectó respuesta de red al guardar ${codigoProducto} (verifica manualmente)`);
  }

  await page.waitForTimeout(1500);

  const closeBtn = page.getByRole('button', { name: 'Close' });
  if (await closeBtn.count() > 0) {
    await closeBtn.click({ timeout: T }).catch(() => {});
  }
  await page.waitForTimeout(800);

  const modalSigueAbierto = await page.locator('.modal.show, [id$="__BV_modal_outer_"]').count();
  if (modalSigueAbierto > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  return codigoProducto;
}

// ==================== TEST PRINCIPAL ====================
test('Automatización: Carga masiva de imágenes SIESAM (1300 imágenes, resiliente)', async () => {
  test.setTimeout(0);

  const inicioTest = Date.now();

  const imagesDir = path.join(process.cwd(), 'mis_imagenes');
  const files = fs.readdirSync(imagesDir);
  const imageFiles = files.filter(f => f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.jpeg'));

  log(`📸 Se encontraron ${imageFiles.length} imágenes para subir al sistema.`);
  log(`📝 Log detallado guardándose en: ${LOG_FILE}`);

  const progreso = cargarProgreso();
  const yaCompletados = new Set(progreso.completados);

  const pendientes = imageFiles.filter(f => {
    const codigo = f.replace(/\.[^/.]+$/, "");
    return !yaCompletados.has(codigo);
  });

  log(`⏭️  Ya completados en corridas anteriores: ${yaCompletados.size}`);
  log(`🔜 Pendientes por procesar en esta corrida: ${pendientes.length}`);

  // 👇 Sin "channel" para usar el Chromium instalado manualmente en caché.
  // Si prefieres usar tu Chrome normal de aplicaciones, cambia esta línea a:
  // const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const browser = await chromium.launch({ headless: false });

  let { context, page } = await abrirSesion(browser);

  let crasheo = false;
  page.on('crash', () => {
    log('💥 La página crasheó (evento "crash" detectado).');
    crasheo = true;
  });

  let procesadosDesdeUltimoReinicio = 0;
  let totalProcesadas = 0;
  let exitosasEnTramo = 0;
  const fallidosFinal = [];

  for (const file of pendientes) {
    const codigoProducto = file.replace(/\.[^/.]+$/, "");
    log(`🚀 Procesando código: ${codigoProducto}`);

    let exito = false;
    let ultimoError = null;

    for (let intento = 1; intento <= REINTENTOS_POR_IMAGEN && !exito; intento++) {
      try {
        const codigoProcesado = await procesarImagen(page, imagesDir, file);

        progreso.completados.push(codigoProcesado);
        guardarProgreso(progreso);

        log(`✅ ${codigoProcesado} completado.`);
        procesadosDesdeUltimoReinicio++;
        exitosasEnTramo++;
        exito = true;

      } catch (err) {
        ultimoError = err;
        const esCrash = crasheo || /crash/i.test(err.message);

        log(`❌ Intento ${intento}/${REINTENTOS_POR_IMAGEN} falló para ${codigoProducto}: ${err.message}`);

        if (esCrash) {
          log('🔄 Recreando sesión del navegador tras crash...');
          crasheo = false;
          await context.close().catch(() => {});
          ({ context, page } = await abrirSesion(browser));
          page.on('crash', () => {
            log('💥 La página crasheó (evento "crash" detectado).');
            crasheo = true;
          });
          procesadosDesdeUltimoReinicio = 0;
        } else {
          await page.screenshot({ path: `error_${codigoProducto}_intento${intento}.png` }).catch(() => {});
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(1000);
        }
      }
    }

    if (!exito) {
      fallidosFinal.push({ codigo: codigoProducto, error: ultimoError?.message || 'desconocido' });
    }

    totalProcesadas++;

    if (totalProcesadas % RESUMEN_CADA === 0) {
      const transcurrido = Date.now() - inicioTest;
      const restantes = pendientes.length - totalProcesadas;
      const promedioMsPorImagen = transcurrido / totalProcesadas;
      const estimadoRestanteMs = promedioMsPorImagen * restantes;

      log(`\n📊 ----- RESUMEN PARCIAL (${totalProcesadas}/${pendientes.length}) -----`);
      log(`   ✅ Exitosas en este tramo de ${RESUMEN_CADA}: ${exitosasEnTramo}`);
      log(`   ❌ Fallidas en este tramo: ${RESUMEN_CADA - exitosasEnTramo}`);
      log(`   ⏱️  Tiempo transcurrido: ${formatearDuracion(transcurrido)}`);
      log(`   📈 Estimado restante: ${formatearDuracion(estimadoRestanteMs)} (${restantes} imágenes pendientes)`);
      log(`------------------------------------------------\n`);

      exitosasEnTramo = 0;
    }

    if (procesadosDesdeUltimoReinicio >= RESTART_EVERY) {
      log(`♻️  Reinicio preventivo del navegador tras ${RESTART_EVERY} imágenes...`);
      await context.close().catch(() => {});
      ({ context, page } = await abrirSesion(browser));
      page.on('crash', () => {
        log('💥 La página crasheó (evento "crash" detectado).');
        crasheo = true;
      });
      procesadosDesdeUltimoReinicio = 0;
    }
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const duracionTotal = Date.now() - inicioTest;
  log(`\n===== RESUMEN FINAL =====`);
  log(`✅ Total completados (histórico): ${progreso.completados.length}`);
  log(`❌ Fallidos en esta corrida: ${fallidosFinal.length}`);
  log(`⏱️  Duración total de esta corrida: ${formatearDuracion(duracionTotal)}`);

  if (fallidosFinal.length > 0) {
    const csvContent = 'codigo,error\n' + fallidosFinal
      .map(f => `"${f.codigo}","${f.error.replace(/"/g, '""')}"`)
      .join('\n');
    fs.writeFileSync(CSV_FALLIDOS, csvContent);
    log(`📄 Detalle de fallidos exportado a: ${CSV_FALLIDOS}`);
    log(`Códigos fallidos: ${fallidosFinal.map(f => f.codigo).join(', ')}`);
  }
});