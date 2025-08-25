using { com.studyproject as my } from '../db/schema';

service MyService {
    entity Products as projection on my.Products;
    entity Orders as projection on my.Orders;
    entity Items as projection on my.Items;
    entity WarehouseStock as projection on my.WarehouseStock;
    entity Authors as projection on my.Authors;
    
    action createOrderWithItems (
        shippingAddress: String(1000), 
        OrderItems: array of {
            Product_ProductId: UUID;
            Quantity: Integer;
            notes: String(1000);
        } 
    ) returns Orders;
    
    action processOrderWithStockUpdate (
        shippingAddress: String(1000),
        OrderItems: array of {
            Product_ProductId: UUID;
            Quantity: Integer;
            notes: String(1000);
        }
    ) returns {
        OrderId: UUID;
        shippingAddress: String(1000);
        OrderItems: array of {};
        message: String;
    };
    
    action cancelOrderWithStockRestore (
        OrderId: UUID
    ) returns {
        message: String;
        restoredItems: Integer;
    };
    
    action restockProducts (
        ProductRestocks: array of {
            ProductId: UUID;
            RestockQuantity: Integer;
            NewLocation: String(100);
        }
    ) returns {
        message: String;
        restockedProducts: array of {};
    };

    action createAuthor(
        Name: String(40),
        Age: Int32,
        Address: String(40)
    ) returns {
        message: String;    };

    action updateAuthor(
        AuthoursId: UUID,
        Name: String(40),
        Age: Int32,
        Address: String(40)
    ) returns {
        message: String;
    };
    action deleteAuthor(
        AuthoursId: UUID,
    ) returns {
        message: String;
    };
        action sendOrderConfirmationEmail (
        OrderNumber: String,
        CustomerEmail: String,
        CustomerName: String,
        EmailNotificationFlag: Boolean,
        OrderTrackingNumber: String

    ) returns {
        message: String;
    }
}