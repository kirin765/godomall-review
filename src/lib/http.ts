import { NextResponse } from 'next/server';

// Next builds req.url from its internal bind address, so absolute redirects based
// on it point at http://localhost:<port> behind the Cloudflare tunnel. A relative
// Location resolves against the public request URL in the browser.
export function relativeRedirect(location: string, status = 307): NextResponse {
  return new NextResponse(null, { status, headers: { location } });
}
