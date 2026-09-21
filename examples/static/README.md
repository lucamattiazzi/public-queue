# A frontend with no framework or backend

From the repository root after building:

```sh
cp dist/packages/sdk/index.js examples/static/sdk.js
python3 -m http.server 5173 --bind 127.0.0.1 --directory examples/static
```

Start the queue with `PQ_ORIGINS=http://127.0.0.1:5173`, then open `http://127.0.0.1:5173`. Paste a private client connection created in the console. The site can be uploaded to any static host; add its HTTPS origin to `PQ_ORIGINS`.

The connection is user-supplied, never embedded into the page. A real application can replace the paste form with its own authenticated credential flow. Browser decryption keys remain tied to this frontend's origin, not to the queue origin. Returning to the same frontend and entering the same connection lets you resume the stored job ID.
