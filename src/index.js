
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    try {
      if (url.pathname === "/api/products" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT id, name, category, description, price, image_url FROM products WHERE active = 1 ORDER BY id DESC"
        ).all();

        return Response.json(
          { success: true, products: results },
          { headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (url.pathname === "/api/orders" && request.method === "POST") {
        const body = await request.json();
        const { customer_name, phone, address, items } = body;

        if (
          typeof customer_name !== "string" || !customer_name.trim() ||
          typeof phone !== "string" || !phone.trim() ||
          typeof address !== "string" || !address.trim() ||
          !Array.isArray(items) || items.length === 0 || items.length > 50
        ) {
          return Response.json(
            { success: false, error: "Invalid order details." },
            { status: 400, headers: cors }
          );
        }

        const ids = items.map(item => Number(item.id));
        const quantities = items.map(item => Number(item.quantity));

        if (
          ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
          quantities.some(q => !Number.isSafeInteger(q) || q <= 0 || q > 100)
        ) {
          return Response.json(
            { success: false, error: "Invalid product or quantity." },
            { status: 400, headers: cors }
          );
        }

        const uniqueIds = [...new Set(ids)];
        const placeholders = uniqueIds.map(() => "?").join(",");

        const { results: products } = await env.DB.prepare(
          `SELECT id, name, price FROM products
           WHERE active = 1 AND id IN (${placeholders})`
        ).bind(...uniqueIds).all();

        if (products.length !== uniqueIds.length) {
          return Response.json(
            { success: false, error: "A product is unavailable." },
            { status: 400, headers: cors }
          );
        }

        const productMap = new Map(products.map(p => [p.id, p]));

        const cleanItems = items.map((item, i) => {
          const product = productMap.get(ids[i]);
          return {
            id: product.id,
            name: product.name,
            price: Number(product.price),
            quantity: quantities[i]
          };
        });

        const total = cleanItems.reduce(
          (sum, item) => sum + item.price * item.quantity, 0
        );

        const result = await env.DB.prepare(
          `INSERT INTO orders
           (customer_name, phone, address, items, total, payment_method, status)
           VALUES (?, ?, ?, ?, ?, 'COD', 'Pending')`
        ).bind(
          customer_name.trim().slice(0, 120),
          phone.trim().slice(0, 30),
          address.trim().slice(0, 500),
          JSON.stringify(cleanItems),
          total
        ).run();

        return Response.json(
          { success: true, order_id: result.meta.last_row_id, total },
          { status: 201, headers: cors }
        );
      }

      return Response.json(
        { success: false, error: "Not found" },
        { status: 404, headers: cors }
      );
    } catch (error) {
      return Response.json(
        { success: false, error: "Server error. Please try again." },
        { status: 500, headers: cors }
      );
    }
  }
};
