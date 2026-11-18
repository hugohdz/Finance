# Finance · Control de gastos de tarjetas

Sitio estático (GitHub Pages) + backend en **Google Apps Script** que guarda la información en una **Google Sheet** privada.

## Funciones

| # | Requisito | Dónde |
|---|-----------|-------|
| 1 | Captura manual de gastos de crédito y débito con **responsable(s)** y **categoría** (un gasto se puede repartir entre varias personas, p. ej. Netflix a medias) | *Movimientos → + Nuevo gasto* |
| 2 | **Límite mensual** (general o por tarjeta, y por periodo específico) con indicador de qué tan cerca estás o si ya lo rebasaste | *Resumen* · *Configuración → Límites* |
| 3 | **Monto por responsable** con su detalle | *Por responsable* |
| 4 | **Cuadre** de la tarjeta de crédito: suma de responsables = total de movimientos = total del estado de cuenta | *Cuadre* |
| 5 | **Devoluciones** ligadas a la compra original, con reparto proporcional | *Movimientos → + Devolución* |
| 5b | **Devolventes diferidos**: devolución recibida en una sola exhibición que se descuenta mes con mes al responsable (p. ej. sobre una compra a MSI). En el cuadre: estado de cuenta − devolvente = lo que aportan los responsables | *Cuadre → + Devolvente* |
| 6 | **Descarga a Excel** (resumen, movimientos, detalle por responsable, cuadre y una hoja por persona) | botón *Descargar Excel* |
| 7 | **Acceso por responsable**: cada persona entra con su usuario y solo ve sus cargos e historial | *Configuración → Usuarios* |
| + | **Importar Excel** del estado de cuenta (formato actual `Tarjetas <Mes> <Año>.xlsx`) con sugerencia automática de categoría y reparto según meses anteriores; detecta duplicados | *Importar Excel* |

Conceptos:
- **Periodo** = mes de corte del estado de cuenta (`2026-11`), independiente de la fecha de la compra.
- **MSI** se detecta de la descripción, p. ej. `LIVERPOOL (012:013)` → 12/13.
- **Fecha de corte** (Configuración → Tarjetas): en tarjetas de crédito el periodo de un cargo lo define su fecha; con corte el día 13, un cargo del 14 de noviembre va a diciembre. Las mensualidades MSI posteriores a la primera conservan la fecha de compra, por eso quedan exentas. Después del corte solo se registran devoluciones en ese periodo.
- Roles: `admin` (captura y administra todo) y `responsable` (solo consulta lo suyo).

## Estructura

```
index.html          Interfaz
css/styles.css      Estilos (modo claro/oscuro, responsive)
js/config.js        Configuración (sin URL; ver abajo)
js/app.js           Lógica de la app
js/mock.js          Backend de demostración (si no hay URL configurada)
apps-script/        Código del backend para Google Apps Script
```

## Despliegue del backend (Google Sheets + Apps Script)

1. Crea una Google Sheet nueva (p. ej. *Finance DB*). **No la compartas**: solo el script accede a ella.
2. *Extensiones → Apps Script*. Pega `apps-script/Code.gs`. En *Configuración del proyecto* activa "Mostrar appsscript.json" y pega `apps-script/appsscript.json`.
3. Ejecuta la función `setup` (autoriza los permisos). Crea las hojas `Usuarios, Tarjetas, Responsables, Categorias, Movimientos, Asignaciones, Limites, EstadosCuenta` y los catálogos base.
4. En `crearAdminInicial` cambia usuario y contraseña, ejecútala una vez y **borra la contraseña del código**.
5. *Implementar → Nueva implementación → Aplicación web*: **Ejecutar como: Yo**, **Quién tiene acceso: Cualquier usuario**. Copia la URL que termina en `/exec`.
6. **No pongas la URL en el repositorio.** En GitHub Pages la app la pide una vez en la pantalla de acceso y la guarda en el navegador. Para trabajar local, crea `js/config.local.js` (está en `.gitignore`):
   ```js
   window.FINANCE_CONFIG.API_URL = 'https://script.google.com/macros/s/…/exec';
   ```
7. Da de alta los responsables en *Configuración → Responsables* (o en la hoja `Responsables`).
8. (Opcional) Carga los datos históricos desde *Importar Excel* en la app.

> Cada vez que modifiques `Code.gs`: *Implementar → Gestionar implementaciones → Editar → Versión nueva* (la URL se conserva).

## Publicar en GitHub Pages

```bash
git push origin main
```
En GitHub: *Settings → Pages → Build and deployment → Deploy from a branch → main / (root)*.
La app queda en `https://hugohdz.github.io/Finance/`.

## Seguridad

- El repositorio es público: **no subas archivos de Excel ni datos personales** (`.gitignore` ya excluye `*.xlsx`).
- Las contraseñas se guardan con hash SHA-256 + salt; las sesiones duran 8 h y hay bloqueo tras 5 intentos fallidos.
- La Google Sheet no es pública; toda lectura/escritura pasa por el script, que valida sesión y rol (un responsable solo recibe sus propios cargos).

## Modo demo

Abre la app con `?demo` al final de la URL (p. ej. `http://localhost:8000/?demo`) para usarla con datos ficticios guardados solo en el navegador: `admin/admin123` o `consulta/consulta123`.
Para probar local: `python -m http.server` dentro de la carpeta y abrir `http://localhost:8000`.
