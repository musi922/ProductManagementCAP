const cds = require("@sap/cds");

class MyService extends cds.ApplicationService {

    async init() {
        this.before("CREATE", "Products", this.#validateProductEntry);
        this.on("createOrderWithItems", this.#createOrderWithItems);
        this.on("processOrderWithStockUpdate", this.#processOrderWithStockUpdate);
        this.on("cancelOrderWithStockRestore", this.#cancelOrderWithStockRestore);
        this.on("restockProducts", this.#restockProducts);
        this.before("CREATE", "Authors", this.#validateAuthorsEntry);
        this.on("createAuthor", this.#createAuthor);
        this.on("updateAuthor", this.#updateAuthor);
        this.on("deleteAuthor", this.#deleteAuthor);

        this.on("sendOrderConfirmationEmail", this.#sendOrderConfirmationEmail);

        await super.init();
    }

    async #sendOrderConfirmationEmail(req) {
        const { OrderNumber, CustomerName, CustomerEmail, EmailNotificationFlag, OrderTrackingNumber } = req.data;
        const axios = require('axios');

        try {
            if (!OrderNumber) {
                return req.error(400, "OrderNumber is required");
            }
            const existingOrder = await SELECT.one.from('Orders').where({ OrderId: OrderNumber });
            if (!existingOrder) {
                return req.error(404, `Order with ID ${OrderNumber} does not exist`);
            }

            console.log('Order validated:', existingOrder);

            // Get OAuth2 token inline
            const tokenUrl = 'https://924b88d5trial.authentication.us10.hana.ondemand.com/oauth/token';
            const clientId = 'sb-1a77c837-ac48-4a56-91f7-d0d09a0c5872!b499548|it-rt-924b88d5trial!b26655';
            const clientSecret = '62e2cece-4d2e-4c7a-87b8-db7c9d0d0bd1$RaXcAdY85AO0BZOGBDK0w4Mznv5F5ot7RmBXC87azSM=';

            const tokenResponse = await axios.post(tokenUrl,
                'grant_type=client_credentials',
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
                    }
                }
            );

            const accessToken = tokenResponse.data.access_token;

            // Prepare XML payload for CPI
            const xmlPayload = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cxf="http://cxf.component.camel.apache.org/">
            <soapenv:Header/>
            <soapenv:Body>
                <OrderDetails>
                    <OrderNumber>${OrderNumber}</OrderNumber>
                    <CustomerEmail>${CustomerEmail || 'musiric2@gmail.com'}</CustomerEmail>
                    <CustomerName>${CustomerName || 'Valued Customer'}</CustomerName>
                    <EmailNotificationFlag>${EmailNotificationFlag !== false ? 'true' : 'false'}</EmailNotificationFlag>
                    <OrderTrackingNumber>${OrderTrackingNumber || `TND${Math.floor(Math.random() * 100000)}`}</OrderTrackingNumber>
                </OrderDetails>
            </soapenv:Body>
        </soapenv:Envelope>`;

            console.log('Calling CPI service with XML payload:', xmlPayload);

            // Call CPI service with axios (sending XML)
            const cpiResponse = await axios.post(
                'https://924b88d5trial.it-cpitrial05-rt.cfapps.us10-001.hana.ondemand.com/cxf/sendOrderStatus',
                xmlPayload,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/xml',
                        'SOAPAction': ''
                    }
                }
            );

            console.log('CPI service response:', cpiResponse.data);

            return {
                message: "Order confirmation email sent successfully",
                OrderNumber: OrderNumber,
                emailStatus: "sent",
                cpiResponse: cpiResponse.data
            };

        } catch (error) {
            console.error('Failed to send order confirmation:', error.response?.data || error.message);
            return req.error(500, `Failed to send order confirmation: ${error.message}`);
        }
    }
    async #processOrderWithStockUpdate(req) {
        const { shippingAddress, OrderItems, customerName, customerEmail } = req.data;

        return await cds.tx(req, async (tx) => {
            try {
                if (!shippingAddress) return req.error(400, "ERROR_SHIPPING_ADDRESS_REQUIRED");
                if (!OrderItems) return req.error(400, "ERROR_ORDER_ITEMS_REQUIRED");

                for (const item of OrderItems) {
                    const product = await tx.run(
                        SELECT.one.from('Products').where({ ProductId: item.Product_ProductId })
                    );

                    if (!product) return req.error(400, `Product ${item.Product_ProductId} not found`);

                    if (product.Quantity < item.Quantity) {
                        return req.error(400, `Insufficient stock for product ${product.ProductName}. Available: ${product.Quantity}, Requested: ${item.Quantity}`);
                    }

                    const warehouseStock = await tx.run(
                        SELECT.one.from('WarehouseStock').where({ 'Product_ProductId': item.Product_ProductId })
                    );

                    if (warehouseStock && warehouseStock.CurrentStock < item.Quantity) {
                        return req.error(400, `Insufficient warehouse stock for product ${product.ProductName}`);
                    }
                }

                const newOrder = await tx.run(
                    INSERT.into('Orders').entries({ shippingAddress })
                );

                const itemsToInsert = OrderItems.map(item => ({
                    ...item,
                    Order_OrderId: newOrder.OrderId
                }));

                const createdItems = await tx.run(
                    INSERT.into('Items').entries(itemsToInsert)
                );

                // Update stock levels using CDS update operations
                for (const item of OrderItems) {
                    await tx.run(
                        UPDATE('Products')
                            .set({ Quantity: { '-=': item.Quantity } })
                            .where({ ProductId: item.Product_ProductId })
                    );

                    await tx.run(
                        UPDATE('WarehouseStock')
                            .set({ CurrentStock: { '-=': item.Quantity } })
                            .where({ 'Product_ProductId': item.Product_ProductId })
                    );
                }

                return {
                    OrderId: newOrder.OrderId,
                    shippingAddress,
                    OrderItems: createdItems,
                    message: "Order processed successfully with stock updated",
                };

            } catch (error) {
                console.error('Order processing failed:', error);
                throw error;
            }
        });
    }

    async #validateProductEntry(req) {
        const { ProductName, Quantity } = req.data;

        if (!ProductName) return req.error(400, "ERROR_PRODUCTNAME_IS_REQUIRED");
        if (!Quantity) return req.error(400, "ERROR_QUANTITY_IS_REQUIRED");

        const existingProduct = await SELECT.one.from("Products").where({ ProductName });
        if (existingProduct) return req.error(400, "ERROR_PRODUCTNAME_ALREADY_EXISTS");
    }

    async #createOrderWithItems(req) {
        const { shippingAddress, OrderItems } = req.data;

        return await cds.tx(req, async (tx) => {
            if (!shippingAddress) return req.error(400, "ERROR_shippingAddress_IS_REQUIRED");

            const order = await tx.run(INSERT.into('Orders').entries({ shippingAddress }));
            const itemsToInsert = OrderItems.map(item => ({ ...item, Order_OrderId: order.OrderId }));
            await tx.run(INSERT.into('Items').entries(itemsToInsert));

            return {
                ...order,
                shippingAddress,
                OrderItems
            };
        });
    }

    async #cancelOrderWithStockRestore(req) {
        const { OrderId } = req.data;

        return await cds.tx(req, async (tx) => {
            const order = await tx.run(SELECT.one.from('Orders').where({ OrderId }));
            if (!order) return req.error(404, "Order not found");

            const orderItems = await tx.run(
                SELECT.from('Items').where({ 'Order_OrderId': OrderId })
            );

            if (orderItems.length === 0) return req.error(400, "No items found for this order");

            // Restore stock using CDS update operations
            for (const item of orderItems) {
                await tx.run(
                    UPDATE('Products')
                        .set({ Quantity: { '+=': item.Quantity } })
                        .where({ ProductId: item.Product_ProductId })
                );

                await tx.run(
                    UPDATE('WarehouseStock')
                        .set({ CurrentStock: { '+=': item.Quantity } })
                        .where({ 'Product_ProductId': item.Product_ProductId })
                );
            }

            await tx.run(DELETE.from('Items').where({ 'Order_OrderId': OrderId }));
            await tx.run(DELETE.from('Orders').where({ OrderId }));

            return {
                message: `Order ${OrderId} cancelled successfully and stock restored`,
                restoredItems: orderItems.length
            };
        });
    }

    async #restockProducts(req) {
        const { ProductRestocks } = req.data;

        return await cds.tx(req, async (tx) => {
            if (!ProductRestocks) return req.error(400, "No restock data provided");

            const restockResults = [];

            for (const restock of ProductRestocks) {
                const { ProductId, RestockQuantity, NewLocation } = restock;

                const product = await tx.run(SELECT.one.from('Products').where({ ProductId }));
                if (!product) throw new Error(`Product ${ProductId} not found`);

                const updateData = { Quantity: { '+=': RestockQuantity } };
                if (NewLocation) updateData.Location = NewLocation;

                await tx.run(UPDATE('Products').set(updateData).where({ ProductId }));

                const warehouseStock = await tx.run(
                    SELECT.one.from('WarehouseStock').where({ 'Product_ProductId': ProductId })
                );

                if (warehouseStock) {
                    await tx.run(
                        UPDATE('WarehouseStock')
                            .set({
                                CurrentStock: { '+=': RestockQuantity },
                                Location: NewLocation || warehouseStock.Location
                            })
                            .where({ StockId: warehouseStock.StockId })
                    );
                } else {
                    await tx.run(
                        INSERT.into('WarehouseStock').entries({
                            Product_ProductId: ProductId,
                            Category: product.Category,
                            CurrentStock: RestockQuantity,
                            Location: NewLocation || product.Location
                        })
                    );
                }

                restockResults.push({
                    ProductId,
                    ProductName: product.ProductName,
                    PreviousQuantity: product.Quantity,
                    RestockQuantity,
                    NewQuantity: product.Quantity + RestockQuantity
                });
            }

            return {
                message: "Products restocked successfully",
                restockedProducts: restockResults
            };
        });
    }

    async #validateAuthorsEntry(req) {
        const { Name, Age } = req.data;
        if (!Name) return req.error(400, "ERROR_NAME_IS_REQUIRED");
        if (!Age) return req.error(400, "ERROR_AGE_IS_REQUIRED");

        const existingAuthor = await SELECT.one.from("Authors").where({ Name });
        if (existingAuthor) return req.error(400, "NAME_ALREADY_EXISTS");
    }

    async #createAuthor(req) {
        const { Name, Age, Address } = req.data;
        if (!Name) return req.error(400, "ERROR_NAME_IS_REQUIRED");
        if (!Age) return req.error(400, "ERROR_AGE_IS_REQUIRED");

        const author = await INSERT.into('Authors').entries({ Name, Age, Address });
        return await SELECT.one.from('Authors').where({ AuthoursId: author.AuthoursId });
    }

    async #updateAuthor(req) {
        const { AuthoursId, Name, Age, Address } = req.data;
        if (!AuthoursId) return req.error(400, "Error_AuthoursId_is_required");

        const existingAuthor = await SELECT.one.from('Authors').where({ AuthoursId });
        if (!existingAuthor) return req.error(404, "Author not found");

        await UPDATE('Authors').set({ Name, Age, Address }).where({ AuthoursId });
        const updatedAuthor = await SELECT.one.from('Authors').where({ AuthoursId });

        return {
            message: "Author updated successfully",
            Authors: updatedAuthor
        };
    }

    async #deleteAuthor(req) {
        const { AuthoursId } = req.data;
        if (!AuthoursId) return req.error(400, "Error_AuthoursId_is_required");

        await DELETE.from('Authors').where({ AuthoursId });
        return { message: "Author Deleted Successfully" };
    }
}

module.exports = MyService;