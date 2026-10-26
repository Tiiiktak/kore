import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { defineConfig, type Plugin } from 'vite'
import postcss from 'postcss'
import { transform } from 'lightningcss'

// Dev: HMR server on 8199 so the board (real backend) on 8198 can be watched live.
// All API / WS / SSE traffic is proxied to 8198 so the React app talks to the REAL backend;
// auth rides through unchanged (Bearer header for reads/writes, ?token= for SSE/WS).
// Build: vite-plugin-singlefile inlines JS+CSS into ONE dist/index.html, so the Python board
// server keeps serving a single file with zero changes.
const BOARD = 'http://127.0.0.1:8198'

// The single shipped `index.html` is downleveled for old in-app WebViews (如流 / baiduhi =
// Chrome 97, below Tailwind v4's Chrome-111 baseline). This is served to EVERYONE: a modern
// browser renders the downleveled sheet identically (verified by side-by-side diff), so the
// one file replaces the old modern/legacy split and the board needs no UA sniffing. Two gaps
// break the page on Chrome 97:
//   • @layer (Chrome 99): an unknown @layer block is dropped WHOLE → the stylesheet vanished.
//     Lightning CSS doesn't flatten cascade layers, so PostCSS unwraps them (keeping inner
//     rules in source order — how Tailwind v3 shipped, safe for Tailwind's layer order).
//   • oklch() / color-mix() / nesting (Chrome 111/111/112): Lightning CSS lowers these to
//     fallbacks where it can. color-mix() over a CSS variable can't be folded and is absent
//     on < 111 (translucent hovers go missing — cosmetic).
const CSS_TARGETS = { android: 95 << 16, chrome: 95 << 16, edge: 95 << 16, firefox: 90 << 16, ios_saf: 13 << 16, safari: 13 << 16 }

function downlevel(css: string): string {
  const root = postcss.parse(css)
  root.walkAtRules('layer', (rule) => {
    if (rule.nodes) rule.replaceWith(rule.nodes) // @layer name { … } → its inner rules
    else rule.remove() //                           @layer a, b;      (ordering statement)
  })
  const { code } = transform({ filename: 'legacy.css', code: Buffer.from(root.toString()), minify: true, targets: CSS_TARGETS })
  return Buffer.from(code).toString('utf8')
}

// After the single index.html is written, downlevel its Tailwind stylesheet IN PLACE. The real
// sheet is the inlined <style> whose content carries Tailwind's `:root` theme + `--tw` vars (JS
// also contains "<style>" substrings — highlight.js grammar — so we pick by CONTENT, not
// position, and do an exact whole-string swap that never touches the JS bundle).
function downlevelCss(): Plugin {
  return {
    name: 'kore-downlevel-css',
    writeBundle(opts) {
      const dir = opts.dir || path.resolve(import.meta.dirname, 'dist')
      const file = path.join(dir, 'index.html')
      const html = fs.readFileSync(file, 'utf8')
      // Match only a REAL <style> tag — `style` followed by whitespace or `>`, which excludes the
      // JS bundle's grammar strings like `<style(?=\s|>)`. Then pick the block that is actually
      // the Tailwind sheet: has :root + --tw and NO backtick (CSS has none; highlight.js is full
      // of them, so this rejects any JS that leaked into an over-spanning match).
      let best = ''
      const re = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g
      for (let m = re.exec(html); m; m = re.exec(html)) {
        const inner = m[1]
        if (inner.includes(':root') && inner.includes('--tw') && !inner.includes('`') && inner.length > best.length) best = inner
      }
      if (!best) return this.warn('downlevel: Tailwind <style> not found; index.html left as-is')
      fs.writeFileSync(file, html.split(best).join(downlevel(best)))
    },
  }
}

export default defineConfig({
  // downlevelCss runs in writeBundle, AFTER viteSingleFile has inlined the CSS into index.html,
  // and rewrites that one file's stylesheet in place.
  plugins: [react(), tailwindcss(), viteSingleFile(), downlevelCss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: {
    host: true,
    port: 8290,
    strictPort: true,
    allowedHosts: true, // internal tool, reached via the host's LAN IP
    proxy: {
      '/api': { target: BOARD, changeOrigin: true },
      '/ws': { target: BOARD, changeOrigin: true, ws: true },
      '/vendor': { target: BOARD, changeOrigin: true },
      '/healthz': { target: BOARD, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', assetsInlineLimit: 100_000_000, cssCodeSplit: false },
})
