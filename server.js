const express = require('express');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ⚙️ CONFIGURAÇÕES
const CREDENTIALS_BASE64 = "YmM3OWM1Y2ItNjY0Ny00M2JhLWI2OWEtZjY2YmUxYmYxZTQ5OllENGE0NzMvUmtXNmh5N2tkQkVsSHg2R0o4dnVSakEwTHBmaC8vSnY2blE9";
const CIELO_HOST = "cieloecommerce.cielo.com.br";

// 🔧 FUNÇÃO AUXILIAR - Fazer requisição HTTPS
function makeHttpsRequest(options, payload = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body: body });
        }
      });
    });
    
    req.on('error', reject);
    
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// 🔐 FUNÇÃO - Obter Token Cielo
async function getToken() {
  const options = {
    hostname: CIELO_HOST,
    path: '/api/public/v2/token',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${CREDENTIALS_BASE64}`,
      'Content-Type': 'application/json'
    }
  };

  const response = await makeHttpsRequest(options);
  
  if (response.body.access_token) {
    return response.body.access_token;
  } else {
    throw new Error('Falha ao obter token: ' + JSON.stringify(response.body));
  }
}

// 📦 FUNÇÃO - Criar Link Cielo
async function createLink(productName, description, priceInCents) {
  const token = await getToken();

  // Formatação da data (fuso horário Brasil)
  const agora = new Date();
  const brasilTime = new Date(agora.getTime() - (3 * 60 * 60 * 1000));
  const dataFormatada = `${brasilTime.getDate().toString().padStart(2, '0')}-${(brasilTime.getMonth() + 1).toString().padStart(2, '0')}`;
  const nomeComData = `${productName} ${dataFormatada}`;

  const payload = JSON.stringify({
    "Type": "Digital",
    "Name": nomeComData,
    "Description": description || "Link de pagamento",
    "Price": parseInt(priceInCents),
    "Shipping": {
      "Type": "WithoutShipping",
      "Name": "Sem envio"
    }
  });

  const options = {
    hostname: CIELO_HOST,
    path: '/api/public/v1/products/',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const response = await makeHttpsRequest(options, payload);

  if (response.body.shortUrl) {
    const valorReais = (parseInt(priceInCents) / 100).toFixed(2).replace('.', ',');
    
    return {
      status: 'success',
      type: 'created',
      name: nomeComData,
      shortUrl: response.body.shortUrl,
      id: response.body.id,
      price: valorReais,
      message: `✅ Link gerado com sucesso!\n🔗 ${response.body.shortUrl}\n💰 Valor: R$ ${valorReais}\n💳 Até 10x sem juros\n🆔 ${response.body.id}`
    };
  } else {
    throw new Error(`Erro na criação: ${JSON.stringify(response.body)}`);
  }
}

// 🔍 FUNÇÃO - Verificar Pagamento
async function checkPayment(productId) {
  const token = await getToken();

  // Buscar dados do produto
  const productOptions = {
    hostname: CIELO_HOST,
    path: `/api/public/v1/products/${productId}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  const productResponse = await makeHttpsRequest(productOptions);
  
  if (productResponse.status !== 200) {
    throw new Error(`Produto não encontrado: ${productId}`);
  }

  const productData = productResponse.body;

  // Verificar pagamentos
  const paymentOptions = {
    hostname: CIELO_HOST,
    path: `/api/public/v1/products/${productId}/payments`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  const paymentResponse = await makeHttpsRequest(paymentOptions);
  const paymentData = paymentResponse.body;

  const valorReais = (productData.price / 100).toFixed(2).replace('.', ',');
  const temPagamento = paymentData.orders && paymentData.orders.length > 0;

  if (temPagamento) {
    const ultimoPagamento = paymentData.orders[paymentData.orders.length - 1];
    return {
      status: 'success',
      type: 'verified',
      name: productData.name,
      price: valorReais,
      paymentStatus: 'APPROVED',
      paidAt: ultimoPagamento.createdDate || 'Data não disponível',
      productId: productId,
      message: `✅ Pagamento confirmado!\n📦 ${productData.name}\n💰 R$ ${valorReais}\n✅ STATUS: APROVADO\n📅 Pago em: ${ultimoPagamento.createdDate}`
    };
  } else {
    return {
      status: 'success',
      type: 'verified',
      name: productData.name,
      price: valorReais,
      paymentStatus: 'PENDING',
      productId: productId,
      message: `⏳ Pagamento pendente\n📦 ${productData.name}\n💰 R$ ${valorReais}\n⌛ STATUS: AGUARDANDO PAGAMENTO`
    };
  }
}

// 🎯 FUNÇÃO PRINCIPAL - Processar requisição
async function processarCielo(productName, description, priceInCents) {
  try {
    // Detectar se é verificação (UUID pattern)
    const isVerificacao = productName && productName.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    if (isVerificacao) {
      return await checkPayment(productName);
    } else {
      return await createLink(productName, description, priceInCents);
    }
  } catch (error) {
    return {
      status: 'error',
      message: `❌ Erro: ${error.message}`
    };
  }
}

// 📡 ROTA - Criar/Verificar Link
app.post('/api/cielo', async (req, res) => {
  const { productName, description, priceInCents } = req.body;

  if (!productName) {
    return res.status(400).json({ status: 'error', message: 'productName é obrigatório' });
  }

  const result = await processarCielo(productName, description, priceInCents);
  res.json(result);
});

// 📋 ROTA - OpenAPI Schema
app.get('/api/openapi.json', (req, res) => {
  res.json({
    "openapi": "3.0.0",
    "info": {
      "title": "Cielo Payment Link API",
      "version": "1.0.0",
      "description": "API para gerar e verificar links de pagamento Cielo"
    },
    "servers": [
      {
        "url": process.env.SERVER_URL || "http://localhost:3000"
      }
    ],
    "paths": {
      "/api/cielo": {
        "post": {
          "summary": "Gerar ou verificar link de pagamento Cielo",
          "description": "Cria um novo link de pagamento ou verifica o status de um pagamento existente",
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "productName": {
                      "type": "string",
                      "description": "Nome do produto/serviço ou ID do pagamento para verificação (UUID)"
                    },
                    "description": {
                      "type": "string",
                      "description": "Descrição detalhada do produto (opcional)"
                    },
                    "priceInCents": {
                      "type": "string",
                      "description": "Valor em centavos. Ex: R$ 150,00 = '15000'"
                    }
                  },
                  "required": ["productName"]
                }
              }
            }
          },
          "responses": {
            "200": {
              "description": "Link criado ou pagamento verificado com sucesso",
              "content": {
                "application/json": {
                  "schema": {
                    "type": "object",
                    "properties": {
                      "status": {
                        "type": "string",
                        "enum": ["success", "error"]
                      },
                      "type": {
                        "type": "string",
                        "enum": ["created", "verified"]
                      },
                      "shortUrl": {
                        "type": "string",
                        "description": "URL do link de pagamento"
                      },
                      "id": {
                        "type": "string",
                        "description": "ID do pagamento Cielo"
                      },
                      "paymentStatus": {
                        "type": "string",
                        "enum": ["APPROVED", "PENDING"]
                      },
                      "message": {
                        "type": "string"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});

// ❌ ROTA - Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 🚀 INICIAR SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`📋 OpenAPI Schema: http://localhost:${PORT}/api/openapi.json`);
});
