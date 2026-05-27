export default {
  async fetch(request, env) {
    
    // Solo aceptamos POST
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const order = await request.json();

      // Validación mínima
      if (!order.items || !order.total) {
        return new Response(JSON.stringify({
          error: "Invalid order format"
        }), { status: 400 });
      }

      // MOCK: simulamos procesamiento
      const response = {
        success: true,
        message: "Order received correctly",
        orderId: crypto.randomUUID(),
        receivedAt: new Date().toISOString(),
        data: order
      };

      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" }
      });

    } catch (err) {
      return new Response(JSON.stringify({
        error: "Server error",
        details: err.message
      }), { status: 500 });
    }
  }
}