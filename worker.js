export default {
  async fetch(request, env) {
    // Configurar CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Manejar preflight request
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const { items } = body;

        // Crear preferencia en Mercado Pago
        const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            items: items,
            back_urls: {
              success: 'https://agustinalonso2303-star.github.io/ugly-cookie/menu.html?payment=success',
              failure: 'https://agustinalonso2303-star.github.io/ugly-cookie/menu.html?payment=failure',
              pending: 'https://agustinalonso2303-star.github.io/ugly-cookie/menu.html?payment=pending',
            },
            auto_return: 'approved',
          }),
        });

        const mpData = await mpResponse.json();

        return new Response(JSON.stringify({
          init_point: mpData.init_point,
          preference_id: mpData.id,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Método no permitido', { status: 405, headers: corsHeaders });
  },
};
