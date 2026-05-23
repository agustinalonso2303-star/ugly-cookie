const functions = require('firebase-functions');
const admin = require('firebase-admin');
const https = require('https');

admin.initializeApp();

/**
 * Esta función se dispara automáticamente cuando se crea un nuevo documento
 * en la colección 'orders'. Es totalmente invisible para el usuario final.
 */
exports.syncOrderToFudo = functions.firestore
    .document('orders/{orderId}')
    .onCreate(async (snapshot, context) => {
        const order = snapshot.data();
        const orderId = context.params.orderId;

        // Obtener llaves desde Firestore (guardadas por ti en la web)
        const configDoc = await admin.firestore().collection('admin_config').doc('fudo_keys').get();
        
        if (!configDoc.exists) {
            console.error('No se encontraron las llaves de Fudo en Firestore');
            return null;
        }

        const { clientId, clientSecret } = configDoc.data();

        try {
            // 1. Mapeo de datos al formato requerido por la API de Fudo
            const fudoPayload = {
                externalId: orderId,
                customer: {
                    name: order.userName,
                    email: order.userEmail,
                    phone: order.userPhone
                },
                items: order.items.map(item => ({
                    name: item.name,
                    price: item.price,
                    quantity: item.quantity,
                    sku: item.id // Fudo utiliza el ID como SKU
                })),
                total: order.total,
                branchName: order.branch,
                paymentMethod: order.paymentMethod,
                source: "Ugly Cookies Web"
            };

            // 2. Envío a Fudo mediante POST
            // Ajustar la URL según la documentación oficial de Fudo API
            await axios.post('https://api.fudo.com.ar/v1/orders', fudoPayload, {
                headers: {
                    'Authorization': `Basic ${Buffer.from(FUDO_CLIENT_ID + ':' + FUDO_CLIENT_SECRET).toString('base64')}`,
                    'Content-Type': 'application/json'
                }
            });

            // 3. Marcar como sincronizado con éxito
            return snapshot.ref.update({ fudoStatus: 'synced', fudoSyncedAt: admin.firestore.FieldValue.serverTimestamp() });

        } catch (error) {
            console.error('Error sincronizando con Fudo:', error);
            return snapshot.ref.update({ fudoStatus: 'failed', fudoError: error.message });
        }
    });