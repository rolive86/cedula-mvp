# Contexto Completo del Proyecto `cedula-mvp`

## 1) Resumen Ejecutivo

`cedula-mvp` es un MVP orientado a automatizar la confección del escrito **“Acredita Diligenciamiento”** a partir de una **cédula judicial en PDF**.  
El sistema:

1. recibe un PDF escaneado;
2. extrae por OCR el número de expediente;
3. intenta obtener la carátula desde Supabase (con fallback por OCR);
4. inyecta los datos en un template DOCX;
5. convierte ese DOCX a PDF;
6. concatena el PDF generado con la cédula original.

Resultado: un PDF final descargable listo para presentar.

---

## 2) Stack Tecnológico y Dependencias

### Runtime de aplicación
- **Node.js 20** (en Docker): base de ejecución del backend.
- **Express 4.18**: servidor HTTP.
- **Multer 1.4.5-lts.1**: recepción de archivo PDF en multipart/form-data.
- **node-tesseract-ocr 2.2.1**: binding para OCR con Tesseract.

Fuentes:
- `package.json`
- `Dockerfile`

### Dependencias del sistema operativo (críticas)
- **Tesseract OCR** (`tesseract-ocr`, `tesseract-ocr-spa`)
- **Poppler utils** (`pdftotext`, `pdftoppm`, `pdfunite`)
- **LibreOffice headless** para DOCX -> PDF
- **zip/unzip** para manipulación de DOCX (internamente ZIP/XML)

Fuente:
- `Dockerfile`
- uso explícito en `processor.js`

### Frontend
- HTML/CSS/JS vanilla en un único archivo.
- Sin framework SPA ni build step.

Fuente:
- `public/index.html`

---

## 3) Estructura del Repositorio

```text
cedula-mvp/
├── .gitignore
├── Dockerfile
├── README.md
├── package-lock.json
├── package.json
├── processor.js
├── server.js
└── public/
    └── index.html
```

### Rol de cada archivo principal
- `server.js`: capa HTTP/API, serving estático, upload, manejo de temporales y respuesta final.
- `processor.js`: lógica de negocio y pipeline documental completo.
- `public/index.html`: interfaz de usuario y cliente HTTP de `/procesar`.
- `README.md`: documentación de operación y deploy (nivel básico).
- `Dockerfile`: entorno de ejecución reproducible en servidor.

---

## 4) Arquitectura Funcional

## 4.1 Flujo end-to-end (alto nivel)

1. Usuario carga PDF desde navegador.
2. Frontend hace `POST /procesar` con campo `pdf`.
3. Backend guarda temporalmente el archivo y crea un directorio de trabajo aislado.
4. Pipeline extrae `expNro` y `caratula`.
5. Se genera un DOCX final desde template.
6. DOCX se convierte a PDF.
7. PDF generado + PDF original se unen.
8. Backend retorna PDF binario al cliente con metadatos en headers HTTP.

## 4.2 Componentes y responsabilidades

- **Presentación (`public/index.html`)**
  - validación básica de tipo PDF;
  - UX de drag&drop;
  - render de estado de procesamiento;
  - descarga de resultado y visualización de datos extraídos.

- **API (`server.js`)**
  - endpoint `POST /procesar`;
  - endpoint de liveness `GET /health`;
  - control de tamaño de upload (20 MB);
  - limpieza de temporales en `finally`.

- **Motor documental (`processor.js`)**
  - OCR y parsing robusto de expediente;
  - enriquecimiento con consulta remota a Supabase;
  - fallback regex de carátula;
  - composición de documento final (DOCX -> PDF -> merge).

---

## 5) Contrato de API

## 5.1 `POST /procesar`

**Request**
- `Content-Type`: `multipart/form-data`
- Campo requerido: `pdf` (archivo `application/pdf`)

**Response OK (200)**
- Body: PDF binario (`application/pdf`)
- `Content-Disposition`: attachment (`acredita_diligenciamiento.pdf`)
- Headers de negocio:
  - `X-Exp-Nro`: número de expediente extraído
  - `X-Caratula`: carátula URL-encoded

**Errores**
- `400`: cuando no llega archivo.
- `500`: cuando falla procesamiento (`{ error: "..." }`).

## 5.2 `GET /health`

Devuelve `{ "status": "ok" }`.

Fuente:
- `server.js`
- consumo explícito de headers en `public/index.html`

---

## 6) Pipeline Técnico Detallado (`processor.js`)

## 6.1 Extracción de texto del PDF

Estrategia escalonada:

1. **Intento rápido con texto embebido**: `pdftotext -layout`.
2. Si el texto útil es insuficiente, cae a OCR:
   - `pdftoppm -r 300 -png` para rasterizar páginas.
   - OCR página por página con Tesseract (`lang: spa`, `oem: 1`, `psm: 6`).
   - corte anticipado cuando ya detecta expediente.

Objetivo: minimizar costo de OCR cuando el PDF ya trae capa de texto.

## 6.2 Extracción de `expNro` (expediente)

Se aplican varios patrones regex, de más estricto a más tolerante:

- formato limpio `NNNNN/YYYY`;
- formato con espacios alrededor de `/`;
- formato con dígitos separados por espacios;
- búsqueda contextual en bloque cercano a términos de fuero.

Esto responde a ruido típico de OCR (espaciados irregulares y cortes de tabla).

## 6.3 Enriquecimiento de carátula desde Supabase

Consulta REST sobre tabla `pjn_favoritos` usando:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Estrategia de matching del número:
- intento exacto;
- intento con cero prefijado;
- intento sin ceros líderes.

Si existe match, usa `caratula` devuelta por Supabase.

## 6.4 Fallback de carátula por OCR

Si no hay datos en Supabase:
- intenta extraer la carátula desde texto OCR con regex sobre la frase “caratulado: ... que se tramita”.
- soporta comillas tipográficas y comillas ASCII.

Si también falla fallback, el proceso aborta con error explícito.

## 6.5 Generación DOCX por manipulación XML

1. descomprime `.docx` (ZIP);
2. abre `word/document.xml`;
3. reemplaza marcador literal:
   - `INSERTAR LOS DATOS EXTRAIDOS DE LA CEDULA`
4. recomprime a `.docx`.

Requisito duro: el marcador debe existir exactamente en template.

## 6.6 Conversión y armado PDF final

1. `libreoffice --headless --convert-to pdf`;
2. `pdfunite` para concatenar:
   - primero el escrito generado;
   - luego la cédula original.

Salida final: `acredita_final.pdf`.

---

## 7) Modelo de Datos (implícito)

No hay ORM ni DB interna en este repositorio; el dominio se materializa en objetos transitorios:

- **Input**
  - archivo PDF cédula.
- **Datos extraídos**
  - `expNro` (string, ej. `53577/2024`).
  - `caratula` (string).
- **Dato remoto**
  - fila de `pjn_favoritos` con `caratula`, `jurisdiccion`, `juzgado`.
- **Output**
  - PDF compuesto final + headers con metadatos.

---

## 8) Variables de Entorno y Configuración Operativa

### Variables reconocidas por el código
- `PORT`: puerto HTTP (default `3000`).
- `SUPABASE_URL`: base URL REST de Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: credencial de alto privilegio para query.

### Configuración documental
- Template requerido en raíz:
  - `acredita_diligenciamiento.docx`
- Marcador obligatorio dentro del template:
  - `INSERTAR LOS DATOS EXTRAIDOS DE LA CEDULA`

Observación importante: el template no está presente en el snapshot actual del repo; la app depende de su disponibilidad en runtime.

---

## 9) Ejecución Local y Deploy

## 9.1 Ejecución local (conceptual)

1. Instalar dependencias OS (Tesseract + Poppler + LibreOffice + zip/unzip).
2. `npm install`
3. `npm start`
4. Abrir `http://localhost:3000`

Notas:
- El README documenta paquetes para Debian/Ubuntu.
- En Windows, la ruta recomendada para evitar fricción de binarios es correr vía Docker.

## 9.2 Deploy

- Proyecto preparado para deploy containerizado.
- `Dockerfile` instala todo lo necesario del sistema.
- README menciona Railway como plataforma principal.

---

## 10) Calidad, Testing y Observabilidad

### Estado actual
- No hay tests automatizados (unitarios/integración/e2e).
- No hay configuración de lint/format.
- No hay pipeline CI versionado en este repo.
- Logging básico por consola (`console.log`, `console.warn`, `console.error`).

### Implicación
- La confiabilidad depende de pruebas manuales y del entorno de ejecución.
- Cambios en OCR/regex pueden introducir regresiones silenciosas sin suite de validación.

---

## 11) Riesgos Técnicos y Deuda (priorizados)

## Críticos
- **Dependencia de herramientas externas por shell**: cualquier ausencia de binarios rompe el flujo.
- **Template DOCX externo al repo**: si falta o cambia marcador, falla producción.
- **Uso de `SUPABASE_SERVICE_ROLE_KEY` en app runtime**: requiere controles estrictos de secreto.

## Altos
- **Sin autenticación del endpoint `/procesar`**: exposición potencial a uso indebido.
- **Sin rate limiting ni cuotas**: riesgo de consumo abusivo (OCR/LibreOffice son costosos).
- **Multer 1.x**: línea con advertencias de mantenimiento/deprecación en ecosistema.

## Medios
- **Contrato API implícito por headers custom** sin especificación formal versionada.
- **Acoplamiento fuerte de regex a formato documental**: cambios de redacción pueden romper extracción.

---

## 12) Fortalezas del MVP

- Pipeline útil de negocio de punta a punta ya operativo.
- Diseño pragmático con fallback entre fuentes de datos (Supabase/OCR).
- `Dockerfile` reduce variabilidad entre ambientes.
- UI simple y clara para usuario no técnico.

---

## 13) Brechas de Documentación

No están completamente documentados:

- esquema y semántica de `pjn_favoritos`;
- política de gestión y rotación de secretos;
- guía de troubleshooting operacional;
- contrato API formal (ejemplos request/response de error);
- compatibilidad detallada por sistema operativo.

---

## 14) Recomendaciones Técnicas (Roadmap breve)

## Fase 1 (rápida, alto impacto)
- Agregar autenticación básica para `/procesar` o al menos token interno.
- Añadir rate limiting y límites por IP.
- Versionar y validar presencia del template al boot.
- Documentar `.env.example` con variables mínimas.

## Fase 2 (robustez)
- Migrar `multer` a rama mantenida.
- Introducir tests de regresión de parsing (fixtures PDF/imagen).
- Incorporar endpoint de readiness con chequeo de binarios críticos.

## Fase 3 (mantenibilidad)
- Especificar API (OpenAPI mínimo).
- Estandarizar logs estructurados.
- Separar frontend y backend si crece complejidad funcional.

---

## 15) Conclusión

El proyecto cumple bien como MVP vertical y demuestra valor directo en automatización procesal.  
Su principal desafío no está en la lógica de negocio central, sino en la **operabilidad** (dependencias de sistema, secreto de servicio, ausencia de hardening y pruebas).  
Con una capa de seguridad y calidad mínima, puede pasar de MVP funcional a servicio interno confiable.

