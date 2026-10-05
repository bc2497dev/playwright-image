import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== STREAM DE LOGS EN TIEMPO REAL ====================
let sseClients = [];

app.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

function enviarLog(mensaje) {
  const data = JSON.stringify({ mensaje });
  sseClients.forEach(c => c.write(`data: ${data}\n\n`));
}

// ==================== PROCESO ACTIVO ====================
let procesoActivo = null;

// ==================== VERIFICAR CARPETA ====================
// El navegador no puede darnos la ruta absoluta directamente por seguridad,
// así que el usuario la escribe/pega y nosotros la verificamos desde el servidor
app.post('/verificar-carpeta', (req, res) => {
  const { carpeta } = req.body;
  if (!carpeta) return res.status(400).json({ error: 'Ruta vacía.' });

  const rutaLimpia = carpeta.trim().replace(/^["']|["']$/g, ''); // quita comillas si las hay

  if (!fs.existsSync(rutaLimpia)) {
    return res.json({ ok: false, error: `No se encontró la carpeta: ${rutaLimpia}` });
  }

  const archivos = fs.readdirSync(rutaLimpia);
  const imagenes = archivos.filter(f =>
    f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.jpeg')
  );

  if (imagenes.length === 0) {
    return res.json({ ok: false, error: 'La carpeta no contiene imágenes (.jpg, .png, .jpeg).' });
  }

  res.json({ ok: true, total: imagenes.length, ruta: rutaLimpia });
});

// ==================== INICIAR ====================
app.post('/iniciar', (req, res) => {
  const { url, usuario, clave, carpeta, mostrarNavegador, reiniciar } = req.body;

  if (!url || !usuario || !clave || !carpeta) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }

  if (procesoActivo) {
    return res.status(400).json({ error: 'Ya hay un proceso en ejecución.' });
  }

  const rutaLimpia = carpeta.trim().replace(/^["']|["']$/g, '');

  if (!fs.existsSync(rutaLimpia)) {
    return res.status(400).json({ error: `La carpeta no existe: ${rutaLimpia}` });
  }

  // Guardar config para que la lea el spec
  const config = { url, usuario, clave, carpeta: rutaLimpia, mostrarNavegador: !!mostrarNavegador };
  fs.writeFileSync(path.join(__dirname, 'config_actual.json'), JSON.stringify(config, null, 2));

  // Borrar progreso anterior si se pidió
  const progressFile = path.join(__dirname, 'progreso_subida.json');
  if (reiniciar && fs.existsSync(progressFile)) {
    fs.unlinkSync(progressFile);
    enviarLog('🗑️ Progreso anterior borrado. Empezando desde cero.');
  }

  res.json({ ok: true });

  // Lanzar Playwright como proceso hijo
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  procesoActivo = spawn(cmd, ['playwright', 'test', 'tests/subida.spec.js', '--headed'], {
    cwd: __dirname,
    env: { ...process.env },
  });

  procesoActivo.stdout.on('data', (data) => {
    data.toString().split('\n').forEach(linea => {
      if (linea.trim()) enviarLog(linea);
    });
  });

  procesoActivo.stderr.on('data', (data) => {
    data.toString().split('\n').forEach(linea => {
      if (linea.trim()) enviarLog(linea);
    });
  });

  procesoActivo.on('close', (code) => {
    enviarLog(`\n🏁 Proceso finalizado con código: ${code}`);
    enviarLog('__FIN__');
    procesoActivo = null;
  });
});

// ==================== DETENER ====================
app.post('/detener', (req, res) => {
  if (!procesoActivo) {
    return res.json({ ok: false, mensaje: 'No hay proceso activo.' });
  }
  procesoActivo.kill();
  procesoActivo = null;
  enviarLog('⛔ Proceso detenido manualmente.');
  res.json({ ok: true });
});

// ==================== ESTADO ====================
app.get('/estado', (req, res) => {
  res.json({ activo: !!procesoActivo });
});

// ==================== PROGRESO ====================
app.get('/progreso', (req, res) => {
  const progressFile = path.join(__dirname, 'progreso_subida.json');
  if (fs.existsSync(progressFile)) {
    const data = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    res.json({ completados: data.completados.length });
  } else {
    res.json({ completados: 0 });
  }
});

// ==================== DESCARGAR CSV DE FALLIDOS ====================
app.get('/fallidos', (req, res) => {
  const csvFile = path.join(__dirname, 'fallidos_final.csv');
  if (fs.existsSync(csvFile)) {
    res.download(csvFile);
  } else {
    res.status(404).json({ error: 'No hay archivo de fallidos aún.' });
  }
});

app.listen(PORT, () => {
  console.log('\n✅ App SIESAM corriendo en http://localhost:' + PORT);
  console.log('   Abre ese link en tu navegador para usar la interfaz.\n');
});