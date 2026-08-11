import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test('Automatización: Carga masiva de imágenes SIESAM', async ({ page }) => {

  test.setTimeout(0); // Sin límite para el TEST completo (tenemos 512 imágenes)

  const imagesDir = path.join(process.cwd(), 'mis_imagenes');
  const files = fs.readdirSync(imagesDir);
  const imageFiles = files.filter(file => file.endsWith('.jpg') || file.endsWith('.png') || file.endsWith('.jpeg'));

  console.log(`📸 Se encontraron ${imageFiles.length} imágenes para subir al sistema.`);

  let exitosos = 0;
  let fallidos = [];

  const T = 8000; // Timeout explícito para cada acción individual (8s)

  await page.goto('https://app16.siesam.com.bo/?multitiendas-dd/#/');
  await page.getByRole('textbox', { name: 'Seleccione al usuario' }).fill('<EMAIL>', { timeout: T });
  await page.getByRole('textbox', { name: 'Password' }).fill('<PASSWORD>', { timeout: T });
  await page.getByRole('button', { name: '🏖️ Acceder' }).click({ timeout: T });

  await page.getByRole('link', { name: 'Inventarios' }).first().click({ timeout: T });
  await page.getByRole('link', { name: 'Productos' }).click({ timeout: T });
  await page.waitForTimeout(2000);

  // ---- Cierra cualquier modal de BootstrapVue que haya quedado abierto ----
  async function cerrarModalesAbiertos(page) {
    const modalAbierto = page.locator('.modal.show, [id$="__BV_modal_outer_"]');
    const count = await modalAbierto.count();

    if (count > 0) {
      console.log(`⚠️ Se detectó un modal abierto (${count}). Cerrando con Escape...`);
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

  // ---- Limpia el buscador y escribe el nuevo código, forzando los eventos del framework ----
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
    return searchBox;
  }

  for (const file of imageFiles) {
    const filePath = path.join(imagesDir, file);
    const codigoProducto = file.replace(/\.[^/.]+$/, "");

    console.log(`🚀 Procesando código: ${codigoProducto}`);

    try {
      await cerrarModalesAbiertos(page);
      await limpiarYEscribir(page, codigoProducto);

      const resultado = page.getByText(codigoProducto, { exact: true }).first();
      await resultado.waitFor({ state: 'visible', timeout: T });
      await resultado.click({ timeout: T });

      await page.getByRole('button', { name: 'EDITAR' }).click({ timeout: T });
      await page.getByRole('tab', { name: 'IMÁGENES' }).click({ timeout: T });

      // ---- Verificación: confirmar que existe un input de archivo real en la página ----
      const fileInputCount = await page.locator('input[type="file"]').count();
      if (fileInputCount === 0) {
        throw new Error('No se encontró ningún input[type="file"] en la página.');
      }

      // Usamos el input real de archivo, no el botón decorativo
      await page.locator('input[type="file"]').first().setInputFiles(filePath, { timeout: T });

      // Espera a que aparezca una vista previa de la imagen antes de guardar
      await page.waitForTimeout(500);
      const preview = page.locator('img').last();
      await preview.waitFor({ state: 'visible', timeout: T }).catch(() => {
        console.log(`⚠️ No se detectó vista previa de imagen para ${codigoProducto}`);
      });

      // Captura de diagnóstico antes de guardar (bórralo cuando confirmes que todo funciona)
      await page.screenshot({ path: `debug_tras_setinputfiles_${codigoProducto}.png` }).catch(() => {});

      // Espera la respuesta real del servidor al guardar, en vez de un tiempo fijo
      const [response] = await Promise.all([
        page.waitForResponse(resp => resp.request().method() === 'POST' && resp.status() < 400, { timeout: T }).catch(() => null),
        page.getByRole('button', { name: 'Guardar' }).click({ timeout: T }),
      ]);

      if (!response) {
        console.log(`⚠️ No se detectó respuesta de red al guardar ${codigoProducto} (verifica manualmente)`);
      }

      await page.waitForTimeout(1500);

      // Captura de diagnóstico después de guardar
      await page.screenshot({ path: `debug_tras_guardar_${codigoProducto}.png` }).catch(() => {});

      // ---- Cerrar el modal de imágenes ----
      const closeBtn = page.getByRole('button', { name: 'Close' });
      if (await closeBtn.count() > 0) {
        await closeBtn.click({ timeout: T }).catch(() => {});
      }
      await page.waitForTimeout(800);

      const modalSigueAbierto = await page.locator('.modal.show, [id$="__BV_modal_outer_"]').count();
      if (modalSigueAbierto > 0) {
        console.log('⚠️ El modal no cerró con el botón Close, forzando con Escape...');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      }

      console.log(`✅ ${codigoProducto} completado.`);
      exitosos++;

    } catch (err) {
      console.error(`❌ Falló el código ${codigoProducto}: ${err.message}`);
      fallidos.push(codigoProducto);
      await page.screenshot({ path: `error_${codigoProducto}.png` }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1000);
    }
  }

  console.log(`\n===== RESUMEN =====`);
  console.log(`✅ Exitosos: ${exitosos}`);
  console.log(`❌ Fallidos: ${fallidos.length}`);
  if (fallidos.length > 0) {
    console.log(`Códigos fallidos: ${fallidos.join(', ')}`);
  }
});