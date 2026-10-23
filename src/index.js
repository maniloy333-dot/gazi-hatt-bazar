export default { async fetch(request, env) { const url = new URL(request.url);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const respond = (data, status = 200) =>
  Response.json(data, { status, headers: cors });

if (request.method === "OPTIONS") {
  return new Response(null, { status: 204, headers: cors });
}

try {
  // Public: Get active products
  if (url.pathname === "/api/products" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, name, category, description, price, image_url
       FROM products
       WHERE active = 1
       ORDER BY id DESC`
    ).all();

    return respond({ success: true, products: results });
  }

  // Admin authentication
  if (url.pathname.startsWith("/api/admin/")) {
    const password = env.ADMIN_PASSWORD;
    const auth = request.headers.get("Authorization") || "";

    if (!password || auth !== `Bearer ${password}`) {
      return respond(
        { success: false, error: "Unauthorized" },
        401
      );
    }
  }

  // Admin: Add a product
  if (
    url.pathname === "/api/admin/products" &&
    request.method === "POST"
  ) {
    const body = await request.json();

    const name =
      typeof body.name === "string" ? body.name.trim() : "";
    const category =
      typeof body.category === "string" ? body.category.trim() : "";
    const description =
      typeof body.description === "string"
        ? body.description.trim()
        : "";
    const image_url =
      typeof body.image_url === "string"
        ? body.image_url.trim()
        : "";
    const price = Number(body.price);

    if (
      !name ||
      !category ||
      !Number.isFinite(price) ||
      price <= 0 ||
      name.length > 150 ||
      category.length > 80 ||
      description.length > 2000 ||
      image_url.length > 2000
    ) {
      return respond(
        { success: false, error: "Invalid product details" },
        400
      );
    }

    const result = await env.DB.prepare(
      `INSERT INTO products
       (name, category, description, price, image_url, active)
       VALUES (?, ?, ?, ?, ?, 1)`
    )
      .bind(name, category, description, price, image_url)
      .run();

    return respond(
      {
        success: true,
        product_id: result.meta.last_row_id
      },
      201
    );
  }

  // Admin: Update product details or deactivate a product
  if (
    /^\/api\/admin\/products\/\d+$/.test(url.pathname) &&
    request.method === "PATCH"
  ) {
    const id = Number(url.pathname.split("/").pop());
    const body = await request.json();

    const existing = await env.DB.prepare(
      "SELECT id FROM products WHERE id = ?"
    )
      .bind(id)
      .first();

    if (!existing) {
      return respond(
        { success: false, error: "Product not found" },
        404
      );
    }

    const allowed = [
      "name",
      "category",
      "description",
      "price",
      "image_url",
      "active"
    ];

    const updates = [];
    const values = [];

    for (const key of allowed) {
      if (!(key in body)) continue;

      let value = body[key];

      if (key === "price") {
        value = Number(value);

        if (!Number.isFinite(value) || value <= 0) {
          return respond(
            { success: false, error: "Invalid price" },
            400
          );
        }
      } else if (key === "active") {
        if (![0, 1, true, false].includes(value)) {
          return respond(
            { success: false, error: "Invalid active value" },
            400
          );
        }

        value = value ? 1 : 0;
      } else {
        const maxLength =
          key === "description" || key === "image_url"
            ? 2000
            : key === "category"
            ? 80
            : 150;

        if (
          typeof value !== "string" ||
          value.trim().length === 0 ||
          value.length > maxLength
        ) {
          return respond(
            { success: false, error: `Invalid ${key}` },
            400
          );
        }

        value = value.trim();
      }

      updates.push(`${key} = ?`);
      values.push(value);
    }

    if (updates.length === 0) {
      return respond(
        { success: false, error: "No valid fields supplied" },
        400
      );
    }

    values.push(id);

    await env.DB.prepare(
      `UPDATE products
       SET ${updates.join(", ")}
       WHERE id = ?`
    )
      .bind(...values)
      .run();

    return respond({ success: true });
  }

  // Admin: View recent orders
  if (
    url.pathname === "/api/admin/orders" &&
    request.method === "GET"
  ) {
    const { results } = await env.DB.prepare(
      `SELECT id, customer_name, phone, address, items, total,
              payment_method, status, created_at
       FROM orders
       ORDER BY id DESC
       LIMIT 200`
    ).all();

    return respond({ success: true, orders: results });
  }

  // Public: Place a Cash on Delivery order
  if (
    url.pathname === "/api/orders" &&
    request.method === "POST"
  ) {
    const body = await request.json();

    const { customer_name, phone, address, items } = body;

    if (
      typeof customer_name !== "string" ||
      !customer_name.trim() ||
      typeof phone !== "string" ||
      !phone.trim() ||
      typeof address !== "string" ||
      !address.trim() ||
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > 50
    ) {
      return respond(
        { success: false, error: "Invalid order details" },
        400
      );
    }

    const ids = items.map(item => Number(item.id));
    const quantities = items.map(item => Number(item.quantity));

    if (
      ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      quantities.some(
        quantity =>
          !Number.isSafeInteger(quantity) ||
          quantity <= 0 ||
          quantity > 100
      )
    ) {
      return respond(
        { success: false, error: "Invalid product or quantity" },
        400
      );
    }

    const uniqueIds = [...new Set(ids)];
    const placeholders = uniqueIds.map(() => "?").join(",");

    const { results: products } = await env.DB.prepare(
      `SELECT id, name, price
       FROM products
       WHERE active = 1 AND id IN (${placeholders})`
    )
      .bind(...uniqueIds)
      .all();

    if (products.length !== uniqueIds.length) {
      return respond(
        { success: false, error: "A product is unavailable" },
        400
      );
    }

    const productMap = new Map(
      products.map(product => [product.id, product])
    );

    const cleanItems = items.map((item, index) => {
      const product = productMap.get(ids[index]);

      return {
        id: product.id,
        name: product.name,
        price: Number(product.price),
        quantity: quantities[index]
      };
    });

    const total = cleanItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    const result = await env.DB.prepare(
      `INSERT INTO orders
       (customer_name, phone, address, items, total,
        payment_method, status)
       VALUES (?, ?, ?, ?, ?, 'COD', 'Pending')`
    )
      .bind(
        customer_name.trim().slice(0, 120),
        phone.trim().slice(0, 30),
        address.trim().slice(0, 500),
        JSON.stringify(cleanItems),
        total
      )
      .run();

    return respond(
      {
        success: true,
        order_id: result.meta.last_row_id,
        total
      },
      201
    );
  }

  return respond(
    { success: false, error: "Not found" },
    404
  );
} catch {
  return respond(
    {
      success: false,
      error: "Server error. Please try again."
    },
    500
  );
}
} };
