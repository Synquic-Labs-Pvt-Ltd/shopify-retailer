const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

// SPEC 8.3 step 8. Static page, so it needs no scripts.
export function renderInstalledPage(shopDomain: string): string {
  const shop = escapeHtml(shopDomain);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Retailer Studio</title>
<style>
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #e7e7e5; color: #0a0a0a; font-family: system-ui, sans-serif; }
main { max-width: 28rem; margin: 1.5rem; padding: 2rem; background: #fff; border-radius: 18px; }
h1 { margin: 0 0 1rem; font-size: 1.5rem; }
p { margin: 0; line-height: 1.5; }
</style>
</head>
<body>
<main>
<h1>Retailer Studio</h1>
<p>Retailer Studio is installed on ${shop}. Open the Retailer Studio app on your phone and log in with ${shop}.</p>
</main>
</body>
</html>
`;
}
