namespace com.studyproject;

entity Products {
    key ProductId: UUID;
    ProductName: String(100);
    Category: String(50);
    Manufacturer: String(100);
    Quantity: Integer;
    Price: Decimal(10, 2);
    Currency: String(3);
    Color: String(50);
    Location: String(100);
    Description: String(500);
    OrderItems: Composition of many Items on OrderItems.Product = $self;
}

entity Orders {
    key OrderId: UUID;
    shippingAddress: String(1000);
    OrderItems: Composition of many Items on OrderItems.Order = $self;
}

entity Items {
    key ItemId: UUID;
    Order: Association to Orders;
    Product: Association to Products;
    Quantity: Integer;
    notes: String(1000);
}

entity WarehouseStock {
    key StockId: UUID;
    Product: Association to Products;
    Category: String(50);
    CurrentStock: Integer;
    Location: String(100);
}

entity Authors {
    key AuthoursId: UUID;
    Name: String(40);
    Age: Integer;
    Address: String(40);
}