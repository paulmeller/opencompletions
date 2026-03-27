export default function DocsPage() {
  return (
    <html>
      <head>
        <title>OpenCompletions API</title>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        <div id="app" />
        <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference" />
        <script
          dangerouslySetInnerHTML={{
            __html: `Scalar.createApiReference('#app', { url: '/openapi.json', download: 'direct' })`,
          }}
        />
      </body>
    </html>
  );
}
