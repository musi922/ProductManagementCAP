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
        await super.init();
    }

    async #validateProductEntry(req) {
        const { ProductName, Quantity } = req.data;

        if (!ProductName) return req.error(400, "ERROR_PRODUCTNAME_IS_REQUIRED");
        if (!Quantity) return req.error(400, "ERROR_QUANTITY_IS_REQUIRED");

        const [existingProductName] = await cds.run(
            SELECT.from("Products").where({ ProductName })
        )
        if (existingProductName) return req.error(400, "ERROR_PRODUCTNAME_ALREADY_EXISTS");
    }

    async #createOrderWithItems(req) {
        const tx = cds.transaction(req);
        const { shippingAddress, OrderItems } = req.data;

        try {
            if (!shippingAddress) return req.error(400, "ERROR_shippingAddress_IS_REQUIRED");

            const [Order] = await tx.run(INSERT.into('Orders').entries({ shippingAddress }));

            const itemsToInsert = OrderItems.map(item => ({ ...item, Order_OrderId: Order.OrderId }));

            await tx.run(INSERT.into('Items').entries(itemsToInsert));

            await tx.commit();

            return {
                ...Order,
                shippingAddress,
                OrderItems
            };
        } catch (error) {
            await tx.rollback();
            req.error(500, 'Failed_to_create_order_with_items');
        }
    }

    async #processOrderWithStockUpdate(req) {
        const tx = cds.transaction(req);
        const { shippingAddress, OrderItems } = req.data;

        try {
            if (!shippingAddress) return req.error(400, "ERROR_SHIPPING_ADDRESS_REQUIRED");
            if (!OrderItems) return req.error(400, "ERROR_ORDER_ITEMS_REQUIRED");

            for (const item of OrderItems) {
                const [product] = await tx.run(
                    SELECT.from('Products').where({ ProductId: item.Product_ProductId })
                );

                if (!product) return req.error(400, `Product ${item.Product_ProductId} not found`);

                if (product.Quantity < item.Quantity) {
                    return req.error(400, `Insufficient stock for product ${product.ProductName}. Available: ${product.Quantity}, Requested: ${item.Quantity}`);
                }

                const [warehouseStock] = await tx.run(
                    SELECT.from('WarehouseStock').where({ 'Product.ProductId': item.Product_ProductId })
                );

                if (warehouseStock && warehouseStock.CurrentStock < item.Quantity) {
                    return req.error(400, `Insufficient warehouse stock for product ${product.ProductName}`);
                }
            }

            const [newOrder] = await tx.run(
                INSERT.into('Orders').entries({ shippingAddress })
            );

            const itemsToInsert = OrderItems.map(item => ({
                ...item,
                Order_OrderId: newOrder.OrderId
            }));

            const createdItems = await tx.run(
                INSERT.into('Items').entries(itemsToInsert)
            );

            for (const item of OrderItems) {
                await tx.run(
                    UPDATE('Products')
                        .set({ Quantity: { '-=': item.Quantity } })
                        .where({ ProductId: item.Product_ProductId })
                );
            }

            for (const item of OrderItems) {
                await tx.run(
                    UPDATE('WarehouseStock')
                        .set({ CurrentStock: { '-=': item.Quantity } })
                        .where({ 'Product.ProductId': item.Product_ProductId })
                );
            }

            await tx.commit();

            return {
                OrderId: newOrder.OrderId,
                shippingAddress,
                OrderItems: createdItems,
                message: "Order processed successfully with stock updated"
            };

        } catch (error) {
            await tx.rollback();
            console.error('Order processing failed:', error);
            return req.error(500, `Failed to process order: ${error.message}`);
        }
    }

    async #cancelOrderWithStockRestore(req) {
        const tx = cds.transaction(req);
        const { OrderId } = req.data;

        try {
            const [order] = await tx.run(
                SELECT.from('Orders').where({ OrderId })
            );

            if (!order) return req.error(404, "Order not found");

            const orderItems = await tx.run(
                SELECT.from('Items').where({ 'Order.OrderId': OrderId })
            );

            if (orderItems.length === 0) return req.error(400, "No items found for this order");

            for (const item of orderItems) {
                await tx.run(
                    UPDATE('Products')
                        .set({ Quantity: { '+=': item.Quantity } })
                        .where({ ProductId: item.Product_ProductId })
                );
            }

            for (const item of orderItems) {
                await tx.run(
                    UPDATE('WarehouseStock')
                        .set({ CurrentStock: { '+=': item.Quantity } })
                        .where({ 'Product.ProductId': item.Product_ProductId })
                );
            }

            await tx.run(
                DELETE.from('Items').where({ 'Order.OrderId': OrderId })
            );

            await tx.run(
                DELETE.from('Orders').where({ OrderId })
            );

            await tx.commit();

            return {
                message: `Order ${OrderId} cancelled successfully and stock restored`,
                restoredItems: orderItems.length
            };

        } catch (error) {
            await tx.rollback();
            return req.error(500, `Failed to cancel order: ${error.message}`);
        }
    }

    async #restockProducts(req) {
        const tx = cds.transaction(req);
        const { ProductRestocks } = req.data;

        try {
            if (!ProductRestocks) return req.error(400, "No restock data provided");

            const restockResults = [];

            for (const restock of ProductRestocks) {
                const { ProductId, RestockQuantity, NewLocation } = restock;

                const [product] = await tx.run(
                    SELECT.from('Products').where({ ProductId })
                );

                if (!product) throw new Error(`Product ${ProductId} not found`);

                const updateData = { Quantity: { '+=': RestockQuantity } };
                if (NewLocation) {
                    updateData.Location = NewLocation;
                }

                await tx.run(
                    UPDATE('Products')
                        .set(updateData)
                        .where({ ProductId })
                );

                const [warehouseStock] = await tx.run(
                    SELECT.from('WarehouseStock').where({ 'Product.ProductId': ProductId })
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

            await tx.commit();

            return {
                message: "Products restocked successfully",
                restockedProducts: restockResults
            };

        } catch (error) {
            await tx.rollback();
            return req.error(500, `Failed to restock products: ${error.message}`);
        }
    }

    async #validateAuthorsEntry(req) {
        const { Name, Age } = req.data;
        if (!Name) return req.error(400, "ERROR_NAME_IS_REQUIRED");
        if (!Age) return req.error(400, "ERROR_AGE_IS_REQUIRED");

        const [existingName] = await SELECT.from("Authors").where({ Name });
        if (existingName) return req.error(400, "NAME_ALREADY_EXISTS");

        const authors = await SELECT.from("Authors");
        console.log("authors:", authors);
    }

    async #createAuthor(req) {
        const { Authors } = cds.entities;
        const { Name, Age } = req.data;
        if (!Name) return req.error(400, "ERROR_NAME_IS_REQUIRED");
        if (!Age) return req.error(400, "ERROR_AGE_IS_REQUIRED");
        const [Author] = await INSERT.into(Authors).entries(req.data);
        const [fullPayload] = await SELECT.from(Authors).where({ AuthoursId: Author.AuthoursId });
        return fullPayload;
    }

    async #updateAuthor(req) {
        const { Authors } = cds.entities;
        const { AuthoursId, Name, Age, Address } = req.data;
        if (!AuthoursId) return req.error(400, "Error_AuthoursId_is_required");
        const [existingAuthor] = await SELECT.from(Authors).where({ AuthoursId });

        if (!existingAuthor) return req.error(404, "Author not found");

        await UPDATE(Authors).set({ Name, Age, Address }).where({ AuthoursId });

        const updatedAuthors = await SELECT.from(Authors).where({ AuthoursId });

        return { message: "Author updated successfully", Authors: updatedAuthors };
    }

    async #deleteAuthor(req) {
        const { Authors } = cds.entities;
        const { AuthoursId } = req.data;
        if (!AuthoursId) return req.error(400, "Error_AuthoursId_is_required");
        await DELETE.from(Authors).where({ AuthoursId });
        return { message: "Author Deleted Successfully" }
    }
}

module.exports = MyService;