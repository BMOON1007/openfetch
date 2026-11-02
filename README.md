# OpenFetch

A local page for checking a public URL before you write a scraper.

It fetches `/robots.txt`, tells you whether your path is allowed, then fetches the page once. You can pass an HTTP proxy you already run. The proxy password is not shown in the report. The client sends its own User-Agent, `OpenFetch/0.1`, rather than pretending to be a browser.

If the site answers with a bot check, the report says so and stops. This tool does not solve captchas, rotate proxies, or try to look like another client.

```
npm test
npm start
```

Open http://127.0.0.1:4180

The page checks `https://example.com` first, so you can see a report immediately. Private addresses, localhost, and link-local metadata addresses are refused. Keep the server on your own machine.

MIT. Heorh Mykhailiuk.
