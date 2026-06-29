const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');

admin.initializeApp();

/**
 * Esta función se dispara automáticamente cuando se crea un nuevo documento
 * en la colección 'orders'. Es totalmente invisible para el usuario final.
 * ENVÍA EL PEDIDO POR WHATSAPP A LA SUCURSAL CORRESPONDIENTE
 */
exports.sendOrderToWhatsApp = functions.firestore
    .document('orders/{orderId}')
    .onCreate(async (snapshot, context) => {
        const order = snapshot.data();
        const orderId = context.params.orderId;

        try {
            // 1. Obtener configuración de WhatsApp desde Firestore
            const configDoc = await admin.firestore().collection('admin_config').doc('whatsapp_config').get();
            
            if (!configDoc.exists) {
                console.error('No se encontró la configuración de WhatsApp');
                return snapshot.ref.update({ whatsappStatus: 'no_config', error: 'No hay configuración de WhatsApp' });
            }

            const whatsappConfig = configDoc.data();
            
            // 2. Obtener información de la sucursal para obtener su número
            const branchDoc = await admin.firestore().collection('branches').doc(order.branch).get();
            
            if (!branchDoc.exists) {
                console.error('No se encontró la sucursal:', order.branch);
                return snapshot.ref.update({ whatsappStatus: 'branch_not_found', error: 'Sucursal no encontrada' });
            }

            const branch = branchDoc.data();
            const branchPhoneNumber = branch.whatsappNumber;

            if (!branchPhoneNumber) {
                console.error('La sucursal no tiene número de WhatsApp configurado:', order.branchId);
                return snapshot.ref.update({ whatsappStatus: 'no_phone', error: 'Sucursal sin número WhatsApp' });
            }

            // 3. Formatear el mensaje de WhatsApp
            const message = formatWhatsAppMessage(order, branch, orderId);

            // 4. Enviar mensaje por WhatsApp Business API
            const whatsappResponse = await sendWhatsAppMessage(
                whatsappConfig.apiKey,
                whatsappConfig.phoneNumberId,
                branchPhoneNumber,
                message
            );

            // 5. Marcar como enviado con éxito
            return snapshot.ref.update({
                whatsappStatus: 'sent',
                whatsappSentAt: admin.firestore.FieldValue.serverTimestamp(),
                whatsappMessageId: whatsappResponse.id
            });

        } catch (error) {
            console.error('Error enviando pedido por WhatsApp:', error);
            return snapshot.ref.update({
                whatsappStatus: 'failed',
                whatsappError: error.message
            });
        }
    });

/**
 * Formatea el mensaje de WhatsApp de forma bonita y legible
 */
function formatWhatsAppMessage(order, branch, orderId) {
    const itemsList = order.items.map(item => 
        `• ${item.quantity}x ${item.name} - $${item.price * item.quantity}`
    ).join('\n');

    const message = `🍪 *NUEVO PEDIDO WEB - UGLY COOKIES*
📍 *Sucursal:* ${branch.name.toUpperCase()}
👤 *Cliente:* ${order.userName || 'No especificado'}
📞 *Tel:* ${order.userPhone || 'No especificado'}
📧 *Email:* ${order.userEmail || 'No especificado'}

📦 *PEDIDO:*
${itemsList}

💰 *TOTAL: $${order.total}*
💳 *Método:* ${order.paymentMethod || 'No especificado'}

⏰ *Hora:* ${new Date().toLocaleTimeString('es-AR')}
🔔 *Pedido web:* #${orderId}

_Confirmar recepción del pedido_`;

    return message;
}

/**
 * Envía mensaje usando WhatsApp Business API (Meta)
 */
async function sendWhatsAppMessage(apiKey, phoneNumberId, toNumber, message) {
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
    
    const response = await axios.post(url, {
        messaging_product: "whatsapp",
        to: toNumber,
        type: "text",
        text: {
            body: message
        }
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });

    return response.data;
}

/**
 * Crea una preferencia de pago en Mercado Pago
 * Esta función es llamada desde el frontend antes de redirigir al cliente a MP
 */
exports.createMercadoPagoPreference = functions.https.onCall(async (data, context) => {
    // Verificar autenticación
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Usuario no autenticado');
    }

    const { items, orderId, branch } = data;

    try {
        // Obtener configuración de Mercado Pago desde Firestore
        const configDoc = await admin.firestore().collection('admin_config').doc('mercadopago_config').get();
        
        if (!configDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'No hay configuración de Mercado Pago');
        }

        const mpConfig = configDoc.data();
        const accessToken = mpConfig.accessToken;

        // Crear preferencia en Mercado Pago
        const preferenceData = {
            items: items.map(item => ({
                title: item.name,
                quantity: item.quantity,
                currency_id: 'ARS',
                unit_price: item.price
            })),
            back_urls: {
                success: `${mpConfig.successUrl}?order_id=${orderId}`,
                failure: `${mpConfig.failureUrl}?order_id=${orderId}`,
                pending: `${mpConfig.pendingUrl}?order_id=${orderId}`
            },
            auto_return: 'approved',
            external_reference: orderId,
            metadata: {
                order_id: orderId,
                branch: branch,
                user_id: context.auth.uid
            }
        };

        const response = await axios.post(
            'https://api.mercadopago.com/checkout/preferences',
            preferenceData,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return {
            success: true,
            init_point: response.data.init_point,
            preferenceId: response.data.id
        };

    } catch (error) {
        console.error('Error creando preferencia de Mercado Pago:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

/**
 * Webhook de Mercado Pago - Recibe notificaciones de pago
 * Esta función es llamada por Mercado Pago cuando se confirma un pago
 */
exports.mercadoPagoWebhook = functions.https.onRequest(async (req, res) => {
    try {
        const { topic, resource } = req.query;

        if (topic === 'payment') {
            // Obtener información del pago desde Mercado Pago
            const configDoc = await admin.firestore().collection('admin_config').doc('mercadopago_config').get();
            
            if (!configDoc.exists) {
                console.error('No hay configuración de Mercado Pago');
                return res.status(500).json({ error: 'No hay configuración de Mercado Pago' });
            }

            const mpConfig = configDoc.data();
            const accessToken = mpConfig.accessToken;

            // Obtener detalles del pago
            const paymentResponse = await axios.get(resource, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            const paymentData = paymentResponse.data;
            const orderId = paymentData.external_reference;

            if (!orderId) {
                console.error('No hay external_reference en el pago');
                return res.status(400).json({ error: 'No hay external_reference' });
            }

            // Verificar estado del pago
            if (paymentData.status === 'approved') {
                // Actualizar orden en Firestore
                await admin.firestore().collection('orders').doc(orderId).update({
                    paymentStatus: 'approved',
                    paymentId: paymentData.id,
                    paymentApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
                    mpPaymentData: paymentData
                });

                // Enviar WhatsApp con confirmación de pago
                await sendOrderToWhatsAppWithPayment(orderId);
            }

            return res.status(200).json({ success: true });
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('Error en webhook de Mercado Pago:', error);
        return res.status(500).json({ error: error.message });
    }
});

/**
 * Envía WhatsApp con confirmación de pago y detalles del pedido
 */
async function sendOrderToWhatsAppWithPayment(orderId) {
    try {
        // Obtener la orden
        const orderDoc = await admin.firestore().collection('orders').doc(orderId).get();
        
        if (!orderDoc.exists) {
            console.error('Orden no encontrada:', orderId);
            return;
        }

        const order = orderDoc.data();

        // Obtener configuración de WhatsApp
        const configDoc = await admin.firestore().collection('admin_config').doc('whatsapp_config').get();
        
        if (!configDoc.exists) {
            console.error('No hay configuración de WhatsApp');
            return;
        }

        const whatsappConfig = configDoc.data();
        
        // Obtener información de la sucursal
        const branchDoc = await admin.firestore().collection('branches').doc(order.branch).get();
        
        if (!branchDoc.exists) {
            console.error('Sucursal no encontrada:', order.branch);
            return;
        }

        const branch = branchDoc.data();
        const branchPhoneNumber = branch.whatsappNumber;

        if (!branchPhoneNumber) {
            console.error('Sucursal sin número WhatsApp:', order.branch);
            return;
        }

        // Formatear mensaje con confirmación de pago
        const message = formatWhatsAppPaymentMessage(order, branch, orderId);

        // Enviar mensaje por WhatsApp
        const whatsappResponse = await sendWhatsAppMessage(
            whatsappConfig.apiKey,
            whatsappConfig.phoneNumberId,
            branchPhoneNumber,
            message
        );

        // Actualizar orden con estado de WhatsApp
        await admin.firestore().collection('orders').doc(orderId).update({
            whatsappStatus: 'sent',
            whatsappSentAt: admin.firestore.FieldValue.serverTimestamp(),
            whatsappMessageId: whatsappResponse.id
        });

    } catch (error) {
        console.error('Error enviando WhatsApp con confirmación de pago:', error);
    }
}

/**
 * Formatea el mensaje de WhatsApp con confirmación de pago
 */
function formatWhatsAppPaymentMessage(order, branch, orderId) {
    let itemsList = '';
    
    // Procesar items, incluyendo detalles de box con gustos seleccionados
    order.items.forEach(item => {
        if (item.flavors && item.flavors.length > 0) {
            // Es una box con gustos seleccionados
            const flavorsText = item.flavors.map(f => `${f.quantity}x ${f.name}`).join(', ');
            itemsList += `• ${item.quantity}x ${item.name} (${flavorsText}) - $${item.price * item.quantity}\n`;
        } else {
            // Es un producto normal
            itemsList += `• ${item.quantity}x ${item.name} - $${item.price * item.quantity}\n`;
        }
    });

    const message = `✅ *PAGO CONFIRMADO - UGLY COOKIES*
📍 *Sucursal:* ${branch.name.toUpperCase()}
👤 *Cliente:* ${order.userName || 'No especificado'}
📞 *Tel:* ${order.userPhone || 'No especificado'}
📧 *Email:* ${order.userEmail || 'No especificado'}

💳 *PAGO APROBADO*
💰 *TOTAL: $${order.total}*
🔗 *ID Pago MP:* ${order.paymentId || 'N/A'}

📦 *PEDIDO:*
${itemsList}

⏰ *Hora confirmación:* ${new Date().toLocaleTimeString('es-AR')}
🔔 *Pedido web:* #${orderId}

✨ *Pedido pagado y confirmado*`;

    return message;
}