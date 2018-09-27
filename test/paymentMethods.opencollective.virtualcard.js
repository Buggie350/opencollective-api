// Test tools
import app from '../server/index';
import sinon from 'sinon';
import moment from 'moment';
import request from 'supertest-as-promised';
import { expect } from 'chai';
import * as utils from './utils';
import models from '../server/models';
import virtualcard from '../server/paymentProviders/opencollective/virtualcard';
import * as store from './features/support/stores';
import emailLib from '../server/lib/email';

const ORDER_TOTAL_AMOUNT = 5000;
const STRIPE_FEE_STUBBED_VALUE = 300;

const createPaymentMethodQuery = `
  mutation createPaymentMethod($amount: Int, $monthlyLimitPerMember: Int, $CollectiveId: Int!, $PaymentMethodId: Int, $description: String, $expiryDate: String, $type: String!, $currency: String!, $limitedToTags: [String], $limitedToCollectiveIds: [Int], $limitedToHostCollectiveIds: [Int]) {
    createPaymentMethod(amount: $amount, monthlyLimitPerMember: $monthlyLimitPerMember, CollectiveId: $CollectiveId, PaymentMethodId: $PaymentMethodId, description: $description, expiryDate: $expiryDate, type:  $type, currency: $currency, limitedToTags: $limitedToTags, limitedToCollectiveIds: $limitedToCollectiveIds, limitedToHostCollectiveIds: $limitedToHostCollectiveIds) {
      id
    }
  }
`;
const claimPaymentMethodQuery = `
  mutation claimPaymentMethod($user: UserInputType, $code: String!) {
    claimPaymentMethod(user: $user, code: $code) {
      id
      SourcePaymentMethodId
      expiryDate
      collective {
        id
        slug
        name
        twitterHandle
      }
    }
  }
`;
const createOrderQuery = `
  mutation createOrder($order: OrderInputType!) {
    createOrder(order: $order) {
      id
      fromCollective {
        id
        slug
      }
      collective {
        id
        slug
      }
      subscription {
        id
        amount
        interval
        isActive
        stripeSubscriptionId
      }
      totalAmount
      currency
      description
    }
  }
`;

describe('opencollective.virtualcard', () => {
  let sandbox, sendEmailSpy;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    // And given that the endpoint for creating customers on Stripe
    // is patched
    utils.stubStripeCreate(sandbox, {
      charge: { currency: 'usd', status: 'succeeded' },
    });
    // And given the stripe stuff that depends on values in the
    // order struct is patch. It's here and not on each test because
    // the `totalAmount' field doesn't change throught the tests.
    utils.stubStripeBalance(
      sandbox,
      ORDER_TOTAL_AMOUNT,
      'usd',
      0,
      STRIPE_FEE_STUBBED_VALUE,
    ); // This is the payment processor fee.
  });

  afterEach(() => sandbox.restore());

  describe('paymentProviders.opencollective.virtualcard', () => {
    describe('#create', async () => {
      let collective1, user1;

      before(() => utils.resetTestDB());
      before('create collective1(currency USD, No Host)', () =>
        models.Collective.create({
          name: 'collective1',
          currency: 'USD',
          isActive: true,
        }).then(c => (collective1 = c)),
      );
      before('creates User 1', () =>
        models.User.createUserWithCollective({ name: 'User 1' }).then(
          u => (user1 = u),
        ),
      );
      before('user1 to become Admin of collective1', () =>
        models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: 'ADMIN',
        }),
      );
      before('create a payment method', () =>
        models.PaymentMethod.create({
          name: '4242',
          service: 'stripe',
          type: 'creditcard',
          token: 'tok_123456781234567812345678',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: null,
        }),
      );

      it('should create a U$100 virtual card payment method', async () => {
        const args = {
          description: 'virtual card test',
          CollectiveId: collective1.id,
          amount: 10000,
          currency: 'USD',
        };
        const paymentMethod = await virtualcard.create(args);
        expect(paymentMethod).to.exist;
        expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
        expect(paymentMethod.initialBalance).to.be.equal(args.amount);
        expect(paymentMethod.service).to.be.equal('opencollective');
        expect(paymentMethod.type).to.be.equal('virtualcard');
        expect(
          moment(paymentMethod.expiryDate).format('YYYY-MM-DD'),
        ).to.be.equal(
          moment()
            .add(3, 'months')
            .format('YYYY-MM-DD'),
        );
      }); /** End Of "should create a U$100 virtual card payment method" */

      it('should create a U$100 virtual card payment method defining an expiry date', async () => {
        const expiryDate = moment().add(6, 'months').format('YYYY-MM-DD');
        const args = {
          description: 'virtual card test',
          CollectiveId: collective1.id,
          amount: 10000,
          currency: 'USD',
          expiryDate: expiryDate,
        };
        const paymentMethod = await virtualcard.create(args);
        expect(paymentMethod).to.exist;
        expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
        expect(paymentMethod.initialBalance).to.be.equal(args.amount);
        expect(paymentMethod.service).to.be.equal('opencollective');
        expect(paymentMethod.type).to.be.equal('virtualcard');
        expect(moment(paymentMethod.expiryDate).format('YYYY-MM-DD')).to.be.equal(expiryDate);
      }); /** End Of "should create a U$100 virtual card payment method defining an expiry date" */

      it('should create a virtual card with monthly limit member of U$100 per month', async () => {
        const args = {
          description: 'virtual card test',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: 10000,
          currency: 'USD',
        };
        const paymentMethod = await virtualcard.create(args);
        expect(paymentMethod).to.exist;
        expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
        expect(paymentMethod.service).to.be.equal('opencollective');
        expect(paymentMethod.type).to.be.equal('virtualcard');
        expect(
          moment(paymentMethod.expiryDate).format('YYYY-MM-DD'),
        ).to.be.equal(
          moment()
            .add(3, 'months')
            .format('YYYY-MM-DD'),
        );
        expect(paymentMethod.monthlyLimitPerMember).to.be.equal(args.monthlyLimitPerMember);
        // paymentMethod.initialBalance should be equals 
        // monthlyLimitPerMember times the months from now until the expiry date
        const monthsFromNowToExpiryDate = Math.round(moment(paymentMethod.expiryDate).diff(moment(), 'months', true));
        expect(paymentMethod.initialBalance).to.be.equal(Math.round(paymentMethod.monthlyLimitPerMember * monthsFromNowToExpiryDate));
      }); /** End Of "should create a virtual card with monthly limit member of U$100 per month" */

      it('should create a virtual card with monthly limit member of U$100 per month defining an expiry date', async () => {
        const expiryDate = moment().add(6, 'months').format('YYYY-MM-DD');
        const args = {
          description: 'virtual card test',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: 10000,
          currency: 'USD',
          expiryDate: expiryDate,
        };
        const paymentMethod = await virtualcard.create(args);
        expect(paymentMethod).to.exist;
        expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
        expect(paymentMethod.service).to.be.equal('opencollective');
        expect(paymentMethod.type).to.be.equal('virtualcard');
        expect(moment(paymentMethod.expiryDate).format('YYYY-MM-DD')).to.be.equal(expiryDate);
        expect(paymentMethod.monthlyLimitPerMember).to.be.equal(args.monthlyLimitPerMember);
        // paymentMethod.initialBalance should be equals 
        // monthlyLimitPerMember times the months from now until the expiry date
        const monthsFromNowToExpiryDate = Math.round(moment(paymentMethod.expiryDate).diff(moment(), 'months', true));
        expect(paymentMethod.initialBalance).to.be.equal(Math.round(paymentMethod.monthlyLimitPerMember * monthsFromNowToExpiryDate));
      }); /** End Of "should create a virtual card with monthly limit member of U$100 per month defining an expiry date" */

    }); /** End Of "#create" */

    describe('#claim', async () => {
      let collective1, paymentMethod1, virtualCardPaymentMethod;

      before(() => utils.resetTestDB());
      before('create collective1(currency USD, No Host)', () =>
        models.Collective.create({
          name: 'collective1',
          currency: 'USD',
          isActive: true,
        }).then(c => (collective1 = c)),
      );
      before('create a credit card payment method', () =>
        models.PaymentMethod.create({
          name: '4242',
          service: 'stripe',
          type: 'creditcard',
          token: 'tok_123456781234567812345678',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: null,
        }).then(pm => (paymentMethod1 = pm)),
      );

      before('create a virtual card payment method', () =>
        virtualcard
          .create({
            description: 'virtual card test',
            CollectiveId: collective1.id,
            amount: 10000,
            currency: 'USD',
          })
          .then(pm => (virtualCardPaymentMethod = pm)),
      );

      it('new User should claim a virtual card', async () => {
        // setting correct code to claim virtual card by new User
        const virtualCardCode = virtualCardPaymentMethod.uuid.substring(0, 8);
        const args = {
          user: { email: 'new@user.com' },
          code: virtualCardCode,
        };
        // claim virtual
        const paymentMethod = await virtualcard.claim(args);
        // payment method should exist
        expect(paymentMethod).to.exist;
        // then paymentMethod SourcePaymentMethodId should be paymentMethod1.id(the PM of the organization collective1)
        expect(paymentMethod.SourcePaymentMethodId).to.be.equal(
          paymentMethod1.id,
        );
        // and collective id of "original" virtual card should be different than the one returned
        expect(virtualCardPaymentMethod.CollectiveId).not.to.be.equal(
          paymentMethod.CollectiveId,
        );
        // then find collective of created user
        const userCollective = await models.Collective.findById(
          paymentMethod.CollectiveId,
        );
        // then find the user
        const user = await models.User.findOne({
          where: {
            CollectiveId: userCollective.id,
          },
        });
        // then check if the user email matches the email on the argument used on the claim
        expect(user.email).to.be.equal(args.user.email);
        // then check if both have the same uuid
        expect(paymentMethod.uuid).not.to.be.equal(virtualCardPaymentMethod.id);
        // and check if both have the same expiry
        expect(moment(paymentMethod.expiryDate).format()).to.be.equal(
          moment(virtualCardPaymentMethod.expiryDate).format(),
        );
      }); /** End Of "new User should claim a virtual card" */
    }); /** End Of "#claim" */

    describe('#processOrder', async () => {
      let host1,
        collective1,
        collective2,
        paymentMethod1,
        virtualCardPaymentMethod,
        user,
        userCollective;

      before(() => utils.resetTestDB());

      before('create Host 1(USD)', () => models.Collective.create({ name: 'Host 1', currency: 'USD', isActive: true }).then(c => {
        host1 = c;
        // Create stripe connected account to host
        return store.stripeConnectedAccount(host1.id);
      }));

      before('create collective1', () => models.Collective.create({ name: 'collective1', currency: 'USD', HostCollectiveId: host1.id, isActive: true }).then(c => collective1 = c));
      before('create collective2', () => models.Collective.create({ name: 'collective2', currency: 'USD', HostCollectiveId: host1.id, isActive: true }).then(c => collective2 = c));
      before('create a credit card payment method', () => models.PaymentMethod.create({
        name: '4242',
        service: 'stripe',
        type: 'creditcard',
        token: 'tok_123456781234567812345678',
        CollectiveId: collective1.id,
        monthlyLimitPerMember: null,
      }).then(pm => paymentMethod1 = pm));

      before('create a virtual card payment method', () => virtualcard.create({
        description: 'virtual card test',
        CollectiveId: collective1.id,
        amount: 10000,
        currency: 'USD',
      }).then(pm => virtualCardPaymentMethod = pm));

      before('new user claims a virtual card', () => virtualcard.claim({
        user: { email: 'new@user.com' },
        code: virtualCardPaymentMethod.uuid.substring(0,8),
      }).then(async (pm) => {
        virtualCardPaymentMethod = await models.PaymentMethod.findById(pm.id);
        userCollective = await models.Collective.findById(virtualCardPaymentMethod.CollectiveId);
        user = await models.User.findOne({
          where: {
            CollectiveId: userCollective.id,
          },
        });
      }));

      it('Order should NOT be executed because its amount exceeds the balance of the virtual card', async () => {
        expect(virtualCardPaymentMethod.SourcePaymentMethodId).to.be.equal(
          paymentMethod1.id,
        );
        const order = await models.Order.create({
          CreatedByUserId: user.id,
          FromCollectiveId: userCollective.id,
          CollectiveId: collective2.id,
          PaymentMethodId: virtualCardPaymentMethod.id,
          totalAmount: 10000000,
          currency: 'USD',
        });
        order.fromCollective = userCollective;
        order.collective = collective2;
        order.createdByUser = user;
        order.paymentMethod = virtualCardPaymentMethod;

        try {
          await virtualcard.processOrder(order);
          throw Error('Process should not be executed...');
        } catch (error) {
          expect(error).to.exist;
          expect(error.toString()).to.contain('Order amount exceeds balance');
        }
      }); /** End Of "Order should NOT be executed because its amount exceeds the balance of the virtual card" */

      it('Process order of a virtual card', async () => {
        const order = await models.Order.create({
          CreatedByUserId: user.id,
          FromCollectiveId: userCollective.id,
          CollectiveId: collective2.id,
          PaymentMethodId: virtualCardPaymentMethod.id,
          totalAmount: ORDER_TOTAL_AMOUNT,
          currency: 'USD',
        });
        order.fromCollective = userCollective;
        order.collective = collective2;
        order.createdByUser = user;
        order.paymentMethod = virtualCardPaymentMethod;

        // checking if transaction generated(CREDIT) matches the correct payment method
        // amount, currency and collectives...
        const creditTransaction = await virtualcard.processOrder(order);
        expect(creditTransaction.type).to.be.equal('CREDIT');
        expect(creditTransaction.PaymentMethodId).to.be.equal(
          virtualCardPaymentMethod.id,
        );
        expect(creditTransaction.FromCollectiveId).to.be.equal(
          userCollective.id,
        );
        expect(creditTransaction.CollectiveId).to.be.equal(collective2.id);
        expect(creditTransaction.amount).to.be.equal(ORDER_TOTAL_AMOUNT);
        expect(creditTransaction.amountInHostCurrency).to.be.equal(
          ORDER_TOTAL_AMOUNT,
        );
        expect(creditTransaction.currency).to.be.equal('USD');
        expect(creditTransaction.hostCurrency).to.be.equal('USD');
        // checking balance of virtual card(should be initial balance - order amount)
        const virtualCardCurrentBalance = await virtualcard.getBalance(
          virtualCardPaymentMethod,
        );
        expect(virtualCardCurrentBalance.amount).to.be.equal(
          virtualCardPaymentMethod.initialBalance - ORDER_TOTAL_AMOUNT,
        );
      }); /** End Of "Process order of a virtual card" */
    }); /** End Of "#processOrder" */
  }); /** End Of "paymentProviders.opencollective.virtualcard" */

  describe('graphql.mutations.paymentMethods.virtualcard', () => {
    describe('#create', async () => {
      let collective1, user1;

      before(() => utils.resetTestDB());
      before('create collective1(currency USD, No Host)', () =>
        models.Collective.create({
          name: 'collective1',
          currency: 'USD',
          isActive: true,
        }).then(c => (collective1 = c)),
      );
      before('creates User 1', () =>
        models.User.createUserWithCollective({ name: 'User 1' }).then(
          u => (user1 = u),
        ),
      );
      before('user1 to become Admin of collective1', () =>
        models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: 'ADMIN',
        }),
      );

      before('create a payment method', () =>
        models.PaymentMethod.create({
          name: '4242',
          service: 'stripe',
          type: 'creditcard',
          token: 'tok_123456781234567812345678',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: null,
        }),
      );

      it('should fail creating a virtual card because there is no currency defined', async () => {
        const args = {
          type: 'virtualcard',
          CollectiveId: collective1.id,
          amount: 10000,
        };
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(
          createPaymentMethodQuery,
          args,
          user1,
        );
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain('"$currency" of required type "String!" was not provided.');
      }); /** End of "should fail creating a virtual card because there is no currency defined" */

      it('should fail creating a virtual card because there is no amount or monthlyLimitPerMember defined', async () => {
        const args = {
          type: 'virtualcard',
          currency: 'USD',
          CollectiveId: collective1.id,
        };
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(
          createPaymentMethodQuery,
          args,
          user1,
        );
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain('you need to define either the amount or the monthlyLimitPerMember of the payment method.');
      }); /** End of "should fail creating a virtual card because there is amount or monthlyLimitPerMember defined" */

      it('should create a U$100 virtual card payment method limited to open source', async () => {
        const args = {
          type: 'virtualcard',
          CollectiveId: collective1.id,
          amount: 10000,
          currency: 'USD',
          limitedToTags: ['open source'],
        };
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(
          createPaymentMethodQuery,
          args,
          user1,
        );

        gqlResult.errors && console.error(gqlResult.errors[0]);
        expect(gqlResult.errors).to.be.empty;
        const paymentMethod = await models.PaymentMethod.findById(
          gqlResult.data.createPaymentMethod.id,
        );
        expect(paymentMethod).to.exist;
        expect(paymentMethod.limitedToTags).to.contain('open source');
        expect(paymentMethod.CreatedByUserId).to.be.equal(user1.id);
        expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
        expect(paymentMethod.initialBalance).to.be.equal(args.amount);
        expect(paymentMethod.service).to.be.equal('opencollective');
        expect(paymentMethod.type).to.be.equal('virtualcard');
        expect(
          moment(paymentMethod.expiryDate).format('YYYY-MM-DD'),
        ).to.be.equal(
          moment()
            .add(3, 'months')
            .format('YYYY-MM-DD'),
        );
      }); /** End of "should create a U$100 virtual card payment method" */
    }); /** End Of "#create" */

    describe('#claim', async () => {
      let collective1, paymentMethod1, virtualCardPaymentMethod;

      before(() => utils.resetTestDB());

      before('create collective1(currency USD, No Host)', () =>
        models.Collective.create({
          name: 'collective1',
          currency: 'USD',
          image: 'https://cldup.com/rdmBCmH20l.png',
          isActive: true
        }).then(c => collective1 = c)
      );

      before('create a credit card payment method', () =>
        models.PaymentMethod.create({
          name: '4242',
          service: 'stripe',
          type: 'creditcard',
          token: 'tok_123456781234567812345678',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: null,
        }).then(pm => paymentMethod1 = pm)
      );

      beforeEach('create a virtual card payment method', () =>
        virtualcard.create({
          description: 'virtual card test',
          CollectiveId: collective1.id,
          amount: 10000,
         currency: 'USD',
        }).then(pm => virtualCardPaymentMethod = pm)
      );

      it('new User should claim a virtual card', async () => {
        // setting correct code to claim virtual card by new User
        const virtualCardCode = virtualCardPaymentMethod.uuid.substring(0, 8);
        const args = {
          user: {
            name: 'New User',
            email: 'new@user.com',
            twitterHandle: 'xdamman'
          },
          code: virtualCardCode,
        };
        // claim virtual card
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(claimPaymentMethodQuery, args);

        gqlResult.errors && console.error(gqlResult.errors[0]);
        expect(gqlResult.errors).to.be.empty;
        const paymentMethod = gqlResult.data.claimPaymentMethod;
        // payment method should exist
        expect(paymentMethod).to.exist;
        // then paymentMethod SourcePaymentMethodId should be paymentMethod1.id(the PM of the organization collective1)
        expect(paymentMethod.SourcePaymentMethodId).to.equal(paymentMethod1.id);
        expect(paymentMethod.collective.name).to.equal(args.user.name);
        expect(paymentMethod.collective.twitterHandle).to.equal(args.user.twitterHandle);
        // and collective id of "original" virtual card should be different than the one returned
        expect(virtualCardPaymentMethod.CollectiveId).not.to.equal(paymentMethod.collective.id);
        // then find collective of created user
        const userCollective = paymentMethod.collective;

        // then find the user
        const user = await models.User.findOne({
          where: {
            CollectiveId: userCollective.id,
          },
        });
        // then check if the user email matches the email on the argument used on the claim
        expect(user.email).to.be.equal(args.user.email);
        // then check if both have the same uuid
        expect(paymentMethod.uuid).not.to.be.equal(virtualCardPaymentMethod.id);
        // and check if both have the same expiry
        expect(moment(new Date(paymentMethod.expiryDate)).format()).to.be
          .equal(moment(virtualCardPaymentMethod.expiryDate).format());

        await utils.waitForCondition(() => sendEmailSpy.callCount > 0);
        expect(sendEmailSpy.firstCall.args[0]).to.equal(args.user.email);
        expect(sendEmailSpy.firstCall.args[1]).to.contain('You received $100 from collective1 to donate on Open Collective');
        expect(sendEmailSpy.firstCall.args[2]).to.contain('next=/redeemed?amount=10000&currency=USD&emitterName=collective1&emitterSlug=collective1&name=New%20User');
        expect(sendEmailSpy.firstCall.args[2]).to.contain(collective1.image.substr(collective1.image.lastIndexOf('/')+1));

      }); /** End Of "#new User should claim a virtual card" */

      it('Existing User should claim a virtual card', async () => {
        const existingUser = await models.User.createUserWithCollective({
          name: 'Existing User',
        });
        // setting correct code to claim virtual card by new User
        const virtualCardCode = virtualCardPaymentMethod.uuid.substring(0, 8);
        const args = {
          code: virtualCardCode,
        };
        // claim virtual card
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(claimPaymentMethodQuery, args , existingUser);

        gqlResult.errors && console.error(gqlResult.errors[0]);
        expect(gqlResult.errors).to.be.empty;

        const paymentMethod = await models.PaymentMethod.findById(gqlResult.data.claimPaymentMethod.id);

        // payment method should exist
        expect(paymentMethod).to.exist;
        // then paymentMethod SourcePaymentMethodId should be paymentMethod1.id(the PM of the organization collective1)
        expect(paymentMethod.SourcePaymentMethodId).to.be.equal(
          paymentMethod1.id,
        );
        // and collective id of "original" virtual card should be different than the one returned
        expect(virtualCardPaymentMethod.CollectiveId).not.to.be.equal(
          paymentMethod.CollectiveId,
        );
        // then find collective of created user
        const userCollective = await models.Collective.findById(
          paymentMethod.CollectiveId,
        );
        // then find the user
        const user = await models.User.findOne({
          where: {
            CollectiveId: userCollective.id,
          },
        });
        // compare user from collectiveId on payment method to existingUser(that claimend)
        expect(user.email).to.be.equal(existingUser.email);
        expect(userCollective.id).to.be.equal(existingUser.CollectiveId);
        // then check if both have the same uuid
        expect(paymentMethod.uuid).not.to.be.equal(virtualCardPaymentMethod.id);
        // and check if both have the same expiry
        expect(moment(paymentMethod.expiryDate).format()).to.be.equal(
          moment(virtualCardPaymentMethod.expiryDate).format(),
        );
      }); /** End Of "Existing User should claim a virtual card" */
    }); /** End Of "#claim" */

    describe('#processOrder', async () => {
      let host1,
        host2,
        collective1,
        collective2,
        virtualCardPaymentMethod,
        user1,
        userVirtualCard,
        userVirtualCardCollective;

      before(() => utils.resetTestDB());

      before('create Host 1(USD)', () => models.Collective.create({ name: 'Host 1', currency: 'USD', isActive: true }).then(c => {
        host1 = c;
        // Create stripe connected account to host
        return store.stripeConnectedAccount(host1.id);
      }));
      before('create Host 2(USD)', () => models.Collective.create({ name: 'Host 2', currency: 'USD', isActive: true }).then(c => {
        host2 = c;
        // Create stripe connected account to host
        return store.stripeConnectedAccount(host2.id);
      }));
      before('create collective1', () => models.Collective.create({ name: 'collective1', currency: 'USD', isActive: true, tags: ['open source'] }).then(c => collective1 = c));
      before('create collective2', () => models.Collective.create({ name: 'collective2', currency: 'USD', isActive: true, tags: ['meetup'] }).then(c => collective2 = c));
      before('add hosts', async () => {
        await collective1.addHost(host1);
        await collective1.update({ isActive: true });
        await collective2.addHost(host2);
        await collective2.update({ isActive: true });
      });
      before('creates User 1', () => models.User.createUserWithCollective({ name: 'User 1' }).then(u => user1 = u));
      before('user1 to become Admin of collective1', () => models.Member.create({
        CreatedByUserId: user1.id,
        MemberCollectiveId: user1.CollectiveId,
        CollectiveId: collective1.id,
        role: 'ADMIN',
      }));
      before('create a credit card payment method', () => models.PaymentMethod.create({
        name: '4242',
        service: 'stripe',
        type: 'creditcard',
        token: 'tok_123456781234567812345678',
        CollectiveId: collective1.id,
        monthlyLimitPerMember: null,
      }));

      before('create a virtual card payment method', () => virtualcard.create({
        description: 'virtual card test',
        CollectiveId: collective1.id,
        amount: 10000,
        currency: 'USD',
        limitedToHostCollectiveIds: [host1.id],
        limitedToTags: ['open source'],
      }).then(pm => virtualCardPaymentMethod = pm));

      before('new user claims a virtual card', () => virtualcard.claim({
        user: { email: 'new@user.com' },
        code: virtualCardPaymentMethod.uuid.substring(0,8),
      }).then(async (pm) => {
        virtualCardPaymentMethod = await models.PaymentMethod.findById(pm.id);
        userVirtualCardCollective = await models.Collective.findById(virtualCardPaymentMethod.CollectiveId);
        userVirtualCard = await models.User.findOne({
          where: {
            CollectiveId: userVirtualCardCollective.id,
          },
        });
      }));

      it('Order should NOT be executed because its amount exceeds the balance of the virtual card', async () => {
        // Setting up order
        const order = {
          fromCollective: { id: userVirtualCard.CollectiveId },
          collective: { id: collective1.id },
          paymentMethod: { uuid: virtualCardPaymentMethod.uuid },
          totalAmount: 1000000,
        };
        // Executing queries
        const gqlResult = await utils.graphqlQuery(
          createOrderQuery,
          { order },
          userVirtualCard,
        );
        expect(gqlResult.errors).to.not.be.empty;
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain("You don't have enough funds available");
      }); /** End Of "Order should NOT be executed because its amount exceeds the balance of the virtual card" */

      it('Order should NOT be executed because the virtual card is limited to be used on collectives with tag open source', async () => {
        // Setting up order
        const order = {
          fromCollective: { id: userVirtualCard.CollectiveId },
          collective: { id: collective2.id },
          paymentMethod: { uuid: virtualCardPaymentMethod.uuid },
          totalAmount: 1000,
        };
        // Executing queries
        const gqlResult = await utils.graphqlQuery(
          createOrderQuery,
          { order },
          userVirtualCard,
        );
        expect(gqlResult.errors).to.not.be.empty;
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain('This payment method can only be used for collectives in open source');
      });

      it('Order should NOT be executed because the virtual card is limited to be used on another host', async () => {
        // Setting up order
        await virtualCardPaymentMethod.update({ limitedToTags: null });
        const order = {
          fromCollective: { id: userVirtualCard.CollectiveId },
          collective: { id: collective2.id },
          paymentMethod: { uuid: virtualCardPaymentMethod.uuid },
          totalAmount: 1000,
        };
        // Executing queries
        const gqlResult = await utils.graphqlQuery(
          createOrderQuery,
          { order },
          userVirtualCard,
        );
        expect(gqlResult.errors).to.not.be.empty;
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain('This payment method can only be used for collectives hosted by Host 1');
      });

      it('Process order of a virtual card', async () => {
        // Setting up order
        const order = {
          fromCollective: { id: userVirtualCard.CollectiveId },
          collective: { id: collective1.id },
          paymentMethod: { uuid: virtualCardPaymentMethod.uuid },
          totalAmount: ORDER_TOTAL_AMOUNT,
        };
        // Executing queries
        const gqlResult = await utils.graphqlQuery(
          createOrderQuery,
          { order },
          userVirtualCard,
        );

        gqlResult.errors && console.error(gqlResult.errors[0]);
        expect(gqlResult.errors).to.be.empty;
        const transactions = await models.Transaction.findAll({
          where: {
            OrderId: gqlResult.data.createOrder.id,
          },
          order: [['id', 'DESC']],
          limit: 2,
        });
        // checking if transaction generated(CREDIT) matches the correct payment method
        // amount, currency and collectives...
        const creditTransaction = transactions[0];
        expect(creditTransaction.type).to.be.equal('CREDIT');
        expect(creditTransaction.PaymentMethodId).to.be.equal(
          virtualCardPaymentMethod.id,
        );
        expect(creditTransaction.FromCollectiveId).to.be.equal(
          userVirtualCard.CollectiveId,
        );
        expect(creditTransaction.CollectiveId).to.be.equal(collective1.id);
        expect(creditTransaction.amount).to.be.equal(ORDER_TOTAL_AMOUNT);
        expect(creditTransaction.amountInHostCurrency).to.be.equal(
          ORDER_TOTAL_AMOUNT,
        );
        expect(creditTransaction.currency).to.be.equal('USD');
        expect(creditTransaction.hostCurrency).to.be.equal('USD');
        // checking balance of virtual card(should be initial balance - order amount)
        const virtualCardCurrentBalance = await virtualcard.getBalance(
          virtualCardPaymentMethod,
        );
        expect(virtualCardCurrentBalance.amount).to.be.equal(
          virtualCardPaymentMethod.initialBalance - ORDER_TOTAL_AMOUNT,
        );
      }); /** End Of "Process order of a virtual card" */

      it('should fail when multiple orders exceed the balance of the virtual card', async () => {
        // Setting up order
        const order = {
          fromCollective: { id: userVirtualCard.CollectiveId },
          collective: { id: collective1.id },
          paymentMethod: { uuid: virtualCardPaymentMethod.uuid },
          totalAmount: ORDER_TOTAL_AMOUNT,
        };
        // Executing queries that overstep virtual card balance
        await utils.graphqlQuery(createOrderQuery, { order }, userVirtualCard);
        await utils.graphqlQuery(createOrderQuery, { order }, userVirtualCard);
        const gqlResult = await utils.graphqlQuery(
          createOrderQuery,
          { order },
          userVirtualCard,
        );

        expect(gqlResult.errors).to.not.be.empty;
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain(
          "You don't have enough funds available",
        );
      }); /** End Of "should fail when multiple orders exceed the balance of the virtual card" */
    }); /** End Of "#processOrder" */
  }); /** End Of "graphql.mutations.paymentMethods.virtualcard" */

  describe('routes.paymentMethods.virtualcard', () => {
    describe('POST /payment-methods to Create a virtual card', async () => {
      let collective1, user1, appKeyData;

      before(() => utils.resetTestDB());
      before('generating API KEY)', () =>
        models.Application.create({}).then(key => (appKeyData = key)),
      );
      before('create collective1(currency USD, No Host)', () =>
        models.Collective.create({
          name: 'collective1',
          currency: 'USD',
          isActive: true,
        }).then(c => (collective1 = c)),
      );
      before('creates User 1', () =>
        models.User.createUserWithCollective({ name: 'User 1' }).then(
          u => (user1 = u),
        ),
      );
      before('user1 to become Admin of collective1', () =>
        models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: 'ADMIN',
        }),
      );

      before('create a payment method', () =>
        models.PaymentMethod.create({
          name: '4242',
          service: 'stripe',
          type: 'creditcard',
          token: 'tok_123456781234567812345678',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: null,
        }),
      );

      it('should Get 400 because there is no user authenticated', () => {
        const args = {
          description: 'virtual card test',
          CollectiveId: collective1.id,
          amount: 10000,
          currency: 'USD',
        };
        return request(app)
          .post('/v1/payment-methods')
          .send(args)
          .expect(400);
      }); /** End Of "should Get 400 because there is no user authenticated" */

      it('should fail creating a virtual card without a currency defined', () => {
        const args = {
          CollectiveId: collective1.id,
          amount: 10000,
        };
        return request(app)
          .post('/v1/payment-methods')
          .set('Authorization', `Bearer ${user1.jwt()}`)
          .set('Client-Id', appKeyData.clientId)
          .send(args)
          .expect(400);
      }); /** End Of "should fail creating a virtual card without a currency defined" */

      it('should create a U$100 virtual card payment method', () => {
        const args = {
          CollectiveId: collective1.id,
          amount: 10000,
          currency: 'USD',
          limitedToTags: ['open source', 'diversity in tech'],
          limitedToHostCollectiveIds: [1],
        };
        return request(app)
          .post('/v1/payment-methods')
          .set('Authorization', `Bearer ${user1.jwt()}`)
          .set('Client-Id', appKeyData.clientId)
          .send(args)
          .expect(200)
          .toPromise()
          .then(res => {
            expect(res.body).to.exist;
            const paymentMethod = res.body;
            expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
            expect(paymentMethod.limitedToTags[0]).to.be.equal(args.limitedToTags[0]);
            expect(paymentMethod.limitedToHostCollectiveIds[0]).to.be.equal(args.limitedToHostCollectiveIds[0]);
            expect(paymentMethod.balance).to.be.equal(args.amount);
          });
      }); /** End Of "should create a U$100 virtual card payment method" */

      it('should create a virtual card with monthly limit member of U$100 per month', () => {
        const args = {
          CollectiveId: collective1.id,
          monthlyLimitPerMember: 10000,
          currency: 'USD',
          limitedToTags: ['open source', 'diversity in tech'],
          limitedToHostCollectiveIds: [1],
        };
        return request(app)
          .post('/v1/payment-methods')
          .set('Authorization', `Bearer ${user1.jwt()}`)
          .set('Client-Id', appKeyData.clientId)
          .send(args)
          .expect(200)
          .toPromise()
          .then(res => {
            expect(res.body).to.exist;
            const paymentMethod = res.body;
            expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
            expect(paymentMethod.limitedToTags[0]).to.be.equal(args.limitedToTags[0]);
            expect(paymentMethod.limitedToHostCollectiveIds[0]).to.be.equal(args.limitedToHostCollectiveIds[0]);
            expect(
              moment(paymentMethod.expiryDate).format('YYYY-MM-DD'),
            ).to.be.equal(
              moment()
                .add(3, 'months')
                .format('YYYY-MM-DD'),
            );
            expect(paymentMethod.monthlyLimitPerMember).to.be.equal(args.monthlyLimitPerMember);
            // paymentMethod.initialBalance should be equals 
            // monthlyLimitPerMember times the months from now until the expiry date
            const monthsFromNowToExpiryDate = Math.round(moment(paymentMethod.expiryDate).diff(moment(), 'months', true));
            expect(paymentMethod.balance).to.be.equal(Math.round(paymentMethod.monthlyLimitPerMember * monthsFromNowToExpiryDate));
          });
      }); /** End Of "should create a virtual card with monthly limit member of U$100 per month" */
    }); /** End Of "POST /payment-methods to Create a virtual card" */
  }); /** End Of "routes.paymentMethods.virtualcard" */
});
