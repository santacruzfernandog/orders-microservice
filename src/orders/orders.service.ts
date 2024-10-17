import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { PrismaClient } from '@prisma/client';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { OrderPaginationDto } from './dto';
import { ChangeOrderStatusDto } from './dto/change-order-status.dto';
import { firstValueFrom } from 'rxjs';
import { NATS_SERVICE } from 'src/config';

@Injectable()
export class OrdersService extends PrismaClient implements OnModuleInit {

  private readonly logger = new Logger('OrdersService');

  constructor(
    @Inject(NATS_SERVICE) private readonly client: ClientProxy
  ) {
    super();
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to orders database');
  }
  
  async create(createOrderDto: CreateOrderDto) {

    try {
      const productIds = createOrderDto.items.map(item => item.productId);
      const products: any[] = await firstValueFrom(
        this.client.send({ cmd: 'validate_products' }, productIds)
      );
  
      // Acumulador del precio total de los productos solicitados
      const totalAmount = createOrderDto.items.reduce((accum, orderItem) => {
        const price = products.find(
          product => product.id === orderItem.productId
        ).price;

        return (price * orderItem.quantity) + accum;
      }, 0);

      // Acumulador del total de items de los productos solicitados
      const totalItems = createOrderDto.items.reduce((accum, orderItem) => {
        return accum + orderItem.quantity;
      }, 0);

      // Transacción de base de datos
      const order = await this.order.create({
        data: {
          totalAmount,
          totalItems,
          OrderItem: {
            createMany: {
              data: createOrderDto.items.map(orderItem => ({
                price: products.find(
                  product => product.id === orderItem.productId
                ).price,
                productId: orderItem.productId,
                quantity: orderItem.quantity,
              }))
            }
          }
        },
        include: {
          OrderItem: {
            select: {
              price: true,
              quantity: true,
              productId: true
            }
          }
        }
      })

      return {
        ...order,
        OrderItem: order.OrderItem.map(orderItem => ({
          ...orderItem,
          name: products.find(product => product.id === orderItem.productId).name
        }))
      };
      
    } catch (error) {
      throw new RpcException({
        status: HttpStatus.BAD_REQUEST,
        message: error.message
      })
    }
  }

  async findAll(orderPaginationDto: OrderPaginationDto) {
    const totalPages = await this.order.count({ where: { status: orderPaginationDto.status } });
    const currentPage = orderPaginationDto.page;
    const perPage = orderPaginationDto.limit;

    return {
      data: await this.order.findMany({
        skip: (currentPage - 1) * perPage,
        take: perPage,
        where: { status: orderPaginationDto.status }
      }),
      metadata: {
        totalPages,
        currentPage,
        rowPerPage: perPage,
        lastPage: Math.ceil(totalPages / perPage)
      }
    };
  }

  async findOne(id: string) {
    const order = await this.order.findFirst({
      where: { id },
      include: {
        OrderItem: {
          select: {
            price: true,
            quantity: true,
            productId: true
          }
        }
      }
    });

    if(!order) {
      throw new RpcException({ status: HttpStatus.NOT_FOUND, message: `Order with ID ${id} not found` });
    }

    const productIds = order.OrderItem.map(orderItem => orderItem.productId);
    const products: any[] = await firstValueFrom(
      this.client.send({ cmd: 'validate_products' }, productIds)
    );

    return {
      ...order,
      OrderItem: order.OrderItem.map(orderItem => ({
        ...orderItem,
        name: products.find(product => product.id === orderItem.productId).name
      }))
    };
  }

  async changeStatus(changeOrderStatusDto: ChangeOrderStatusDto) {
    const {id, status} = changeOrderStatusDto;
    const order = await this.findOne(id);

    if(order.status === status) return order;

    return this.order.update({
      where: {id},
      data: {status}
    })
  }
}
