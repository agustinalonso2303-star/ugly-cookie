const { onRequest } = require("firebase-functions/v2/https");

exports.createOrder = onRequest(async (req, res) => {

  res.json({
    success: true,
    message: "Backend funcionando correctamente"
  });

});