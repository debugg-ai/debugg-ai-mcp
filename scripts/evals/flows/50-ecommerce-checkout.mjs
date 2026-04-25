/**
 * The marquee real-user-journey flow: full e-commerce checkout.
 *
 * Fixture is a small SPA with hash-based routing and localStorage cart:
 *   '' (empty)        → shop with 3 products
 *   '#/product/:id'   → product detail with Add to Cart button
 *   '#/cart'          → cart line items + Checkout
 *   '#/checkout'      → shipping form + Place Order
 *   '#/order/:id'     → confirmation page with order ID + items
 *
 * Agent must:
 *   1. From shop, click the USB-C Hub product
 *   2. Click Add to Cart
 *   3. Open cart, verify USB-C Hub at $39.99
 *   4. Click Checkout
 *   5. Fill shipping form (Name, Address, City, ZIP)
 *   6. Click Place Order
 *   7. Verify confirmation page with order ID and the correct item
 *
 * This is ~10-15 agent steps and exercises every primitive at once:
 * navigation, click, fill, content verification, state persistence
 * (cart survives navigation), and final assertion against an item that
 * had to be carried through 5 distinct UI states.
 *
 * The "right" product to pick is unambiguous (USB-C Hub at $39.99),
 * NOT the cheapest or first. If the agent shortcuts by adding any
 * product, the cart-page assertion ("USB-C Hub at $39.99") will fail.
 *
 * ~3-6 minutes wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Mini Shop</title>
  <style>
    body { font-family: sans-serif; padding: 0; margin: 0; color: #111827; }
    header { background: #1f2937; color: white; padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; }
    header a { color: white; text-decoration: none; }
    main { padding: 32px; max-width: 900px; margin: 0 auto; }
    .product-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 20px; }
    .product-card { border: 1px solid #e5e7eb; padding: 20px; border-radius: 8px; cursor: pointer; }
    .product-card:hover { background: #f9fafb; }
    .product-card h3 { margin: 0 0 8px 0; font-size: 16px; }
    .price { color: #2563eb; font-weight: 600; font-size: 18px; }
    button { background: #2563eb; color: white; border: 0; padding: 10px 20px; cursor: pointer; border-radius: 4px; font-size: 14px; }
    button:hover { background: #1d4ed8; }
    .secondary { background: #6b7280; }
    .danger { background: #dc2626; }
    label { display: block; margin-top: 12px; font-weight: 600; }
    input { width: 100%; max-width: 400px; padding: 8px; margin-top: 4px; box-sizing: border-box; }
    .cart-item { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #e5e7eb; }
    .total { font-size: 20px; font-weight: 600; margin-top: 16px; }
    .confirm { background: #d1fae5; color: #065f46; padding: 20px; border-radius: 8px; border-left: 4px solid #059669; }
  </style>
</head>
<body>
  <header>
    <a href="#" id="brand"><h2 style="margin:0;">Mini Shop</h2></a>
    <a href="#/cart" id="cart-link">Cart (<span id="cart-count">0</span>)</a>
  </header>
  <main id="view"></main>

  <script>
    var PRODUCTS = [
      { id: '1', name: 'Wireless Headphones', price: 79.99, description: 'Over-ear noise-canceling headphones with 30-hour battery life.' },
      { id: '2', name: 'USB-C Hub',           price: 39.99, description: '7-in-1 hub with HDMI, SD card reader, and three USB ports.' },
      { id: '3', name: 'Mechanical Keyboard', price: 149.99, description: 'Hot-swappable mechanical keyboard with RGB backlight.' },
    ];

    function getCart() { try { return JSON.parse(localStorage.getItem('cart') || '[]'); } catch { return []; } }
    function setCart(c) { localStorage.setItem('cart', JSON.stringify(c)); refreshHeader(); }
    function clearCart() { setCart([]); }
    function refreshHeader() { document.getElementById('cart-count').textContent = String(getCart().length); }

    function findProduct(id) { return PRODUCTS.find(function (p) { return p.id === id; }); }

    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
    function formatPrice(n) { return '$' + n.toFixed(2); }

    function renderShop() {
      document.getElementById('view').innerHTML =
        '<h1>Browse Products</h1>' +
        '<p>Welcome to Mini Shop. Click any product below to see details.</p>' +
        '<div class="product-grid">' +
          PRODUCTS.map(function (p) {
            return '<div class="product-card" data-id="' + p.id + '"><h3>' + escapeHtml(p.name) + '</h3>' +
              '<p>' + escapeHtml(p.description) + '</p>' +
              '<div class="price">' + formatPrice(p.price) + '</div></div>';
          }).join('') +
        '</div>';
      document.querySelectorAll('.product-card').forEach(function (card) {
        card.addEventListener('click', function () {
          location.hash = '#/product/' + card.getAttribute('data-id');
        });
      });
    }

    function renderProduct(id) {
      var p = findProduct(id);
      if (!p) { document.getElementById('view').innerHTML = '<h1>Product not found</h1>'; return; }
      document.getElementById('view').innerHTML =
        '<a href="#" id="back">← Back to shop</a>' +
        '<h1>' + escapeHtml(p.name) + '</h1>' +
        '<p>' + escapeHtml(p.description) + '</p>' +
        '<div class="price">' + formatPrice(p.price) + '</div>' +
        '<button id="add-to-cart" type="button" style="margin-top: 20px;">Add to Cart</button>';
      document.getElementById('add-to-cart').addEventListener('click', function () {
        var c = getCart();
        c.push({ id: p.id, name: p.name, price: p.price });
        setCart(c);
        location.hash = '#/cart';
      });
    }

    function renderCart() {
      var cart = getCart();
      var view = document.getElementById('view');
      if (cart.length === 0) {
        view.innerHTML = '<h1>Your Cart</h1><p>Your cart is empty.</p><a href="#">Continue shopping</a>';
        return;
      }
      var total = cart.reduce(function (s, i) { return s + i.price; }, 0);
      view.innerHTML =
        '<h1>Your Cart</h1>' +
        cart.map(function (i) {
          return '<div class="cart-item"><span>' + escapeHtml(i.name) + '</span><span>' + formatPrice(i.price) + '</span></div>';
        }).join('') +
        '<div class="total">Total: ' + formatPrice(total) + '</div>' +
        '<button id="checkout" type="button" style="margin-top: 20px;">Checkout</button>';
      document.getElementById('checkout').addEventListener('click', function () {
        location.hash = '#/checkout';
      });
    }

    function renderCheckout() {
      var cart = getCart();
      if (cart.length === 0) { location.hash = '#'; return; }
      var total = cart.reduce(function (s, i) { return s + i.price; }, 0);
      document.getElementById('view').innerHTML =
        '<h1>Checkout</h1>' +
        '<p>Total to pay: <strong>' + formatPrice(total) + '</strong></p>' +
        '<form id="ship-form">' +
          '<label for="name">Full Name</label><input id="name" required />' +
          '<label for="address">Address</label><input id="address" required />' +
          '<label for="city">City</label><input id="city" required />' +
          '<label for="zip">ZIP Code</label><input id="zip" required />' +
          '<button type="submit" style="margin-top: 16px;">Place Order</button>' +
        '</form>';
      document.getElementById('ship-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var orderId = 'ORD-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        var orderData = { id: orderId, items: getCart(), total: total };
        localStorage.setItem('lastOrder', JSON.stringify(orderData));
        clearCart();
        location.hash = '#/order/' + orderId;
      });
    }

    function renderOrder(id) {
      var raw = localStorage.getItem('lastOrder');
      var order = raw ? JSON.parse(raw) : null;
      if (!order || order.id !== id) {
        document.getElementById('view').innerHTML = '<h1>Order not found</h1>';
        return;
      }
      document.getElementById('view').innerHTML =
        '<div class="confirm">' +
          '<h1>Order Confirmed</h1>' +
          '<p>Thank you! Your order has been placed.</p>' +
          '<p><strong>Order ID:</strong> ' + escapeHtml(order.id) + '</p>' +
          '<h3>Items purchased:</h3>' +
          order.items.map(function (i) {
            return '<div class="cart-item"><span>' + escapeHtml(i.name) + '</span><span>' + formatPrice(i.price) + '</span></div>';
          }).join('') +
          '<div class="total">Total paid: ' + formatPrice(order.total) + '</div>' +
        '</div>';
    }

    function route() {
      var h = location.hash || '';
      refreshHeader();
      if (h === '' || h === '#' || h === '#/') return renderShop();
      var m = h.match(/^#\\/product\\/(\\w+)$/);
      if (m) return renderProduct(m[1]);
      if (h === '#/cart') return renderCart();
      if (h === '#/checkout') return renderCheckout();
      m = h.match(/^#\\/order\\/(\\w[\\w-]*)$/);
      if (m) return renderOrder(m[1]);
      renderShop();
    }
    window.addEventListener('hashchange', route);
    // Reset state on every load so the agent starts fresh
    clearCart();
    localStorage.removeItem('lastOrder');
    route();
  </script>
</body>
</html>`;

export const flow = {
  name: 'ecommerce-checkout',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Full e-commerce purchase: pick USB-C Hub → add to cart → checkout → fill shipping → place order → verify confirmation',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: mini-shop SPA at ${url}\x1b[0m`);

    try {
      await step('full checkout journey: pick USB-C Hub → add → cart → checkout → fill → place → confirm', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'You are testing an e-commerce site called Mini Shop. Complete a full purchase end-to-end:\n\n' +
              '1. On the shop page, you will see three products: Wireless Headphones, USB-C Hub, and Mechanical Keyboard. ' +
              'Click specifically on the "USB-C Hub" product card to view its details.\n' +
              '2. On the USB-C Hub product detail page, click the "Add to Cart" button.\n' +
              '3. You should now be on the cart page. Verify the cart contains "USB-C Hub" at price $39.99 ' +
              'and the cart total shows $39.99. Click the "Checkout" button.\n' +
              '4. On the checkout page, fill in the shipping form fields:\n' +
              '   - Full Name: Testbot Tester\n' +
              '   - Address: 123 Test Lane\n' +
              '   - City: Testville\n' +
              '   - ZIP Code: 12345\n' +
              '   Then click the "Place Order" button.\n' +
              '5. On the final confirmation page, verify it shows the heading "Order Confirmed" and ' +
              'lists "USB-C Hub" with price $39.99 as the purchased item. The page should also show an Order ID ' +
              '(format ORD-XXXXXX).\n\n' +
              'The test passes only if the entire journey completes and the confirmation page shows the correct item (USB-C Hub).',
          },
        }, 480_000); // 8min — generous budget for a 5-page journey

        await writeArtifact('checkout-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('checkout-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed checkout journey. outcome='${body.outcome}', success=${body.success}, stepsTaken=${body.stepsTaken}. ` +
          `final intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 500) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        // A 5-page journey should require at minimum 5 distinct interactions
        // (click product, click add-to-cart, click checkout, fill+submit form,
        // verify confirm). If stepsTaken is much lower, agent shortcut something.
        assert(body.stepsTaken >= 5,
          `Expected stepsTaken >=5 for a 5-page journey; got ${body.stepsTaken}. ` +
          `Agent may have skipped steps.`);

        await writeArtifact('action-trace.json', body.actionTrace ?? []);
        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));

        console.log(`  \x1b[2magent stepsTaken=${body.stepsTaken}, durationMs=${body.durationMs}\x1b[0m`);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
