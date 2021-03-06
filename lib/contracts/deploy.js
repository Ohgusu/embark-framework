let async = require('async');

let RunCode = require('../core/runCode.js');

let DeployTracker = require('./deploy_tracker.js');
let ABIGenerator = require('./abi.js');

class Deploy {
  constructor(options) {
    this.web3 = options.web3;
    this.contractsManager = options.contractsManager;
    this.logger = options.logger;
    this.env = options.env;

    this.deployTracker = new DeployTracker({
      logger: options.logger, chainConfig: options.chainConfig, web3: options.web3, env: this.env
    });
  }

  determineArguments(suppliedArgs) {
    let realArgs = [], l, arg, contractName, referedContract;

    for (l = 0; l < suppliedArgs.length; l++) {
      arg = suppliedArgs[l];
      if (arg[0] === "$") {
        contractName = arg.substr(1);
        referedContract = this.contractsManager.getContract(contractName);
        realArgs.push(referedContract.deployedAddress);
      } else {
        realArgs.push(arg);
      }
    }

    return realArgs;
  }

  checkAndDeployContract(contract, params, callback) {
    let self = this;
    let suppliedArgs;
    let realArgs;
    let arg;
    let l;
    let contractName;
    let referedContract;
    contract.error = false;

    if (contract.deploy === false) {
      self.logger.contractsState(self.contractsManager.contractsState());
      return callback();
    }

    if (contract.address !== undefined) {

      realArgs = self.determineArguments(params || contract.args);

      contract.deployedAddress = contract.address;
      self.deployTracker.trackContract(contract.className, contract.realRuntimeBytecode, realArgs, contract.address);
      self.deployTracker.save();
      self.logger.contractsState(self.contractsManager.contractsState());
      return callback();
    }

    let trackedContract = self.deployTracker.getContract(contract.className, contract.realRuntimeBytecode, contract.args);

    if (trackedContract && this.web3.eth.getCode(trackedContract.address) !== "0x") {
      self.logger.info(contract.className.bold.cyan + " already deployed at ".green + trackedContract.address.bold.cyan);
      contract.deployedAddress = trackedContract.address;
      self.logger.contractsState(self.contractsManager.contractsState());
      return callback();
    } else {

      realArgs = self.determineArguments(params || contract.args);

      this.deployContract(contract, realArgs, function (err, address) {
        if (err) {
          return callback(new Error(err));
        }
        self.deployTracker.trackContract(contract.className, contract.realRuntimeBytecode, realArgs, address);
        self.deployTracker.save();
        self.logger.contractsState(self.contractsManager.contractsState());

        if (contract.onDeploy !== undefined) {
          self.logger.info('executing onDeploy commands');
          let abiGenerator = new ABIGenerator({contractsManager: self.contractsManager});
          let abi = abiGenerator.generateContracts(false);
          let cmds = contract.onDeploy.join(';\n');

          RunCode.doEval(abi + "\n" + cmds, self.web3);
        }

        callback();
      });
    }

  }

  deployContract(contract, params, callback) {
    let self = this;
    let contractObject = this.web3.eth.contract(contract.abiDefinition);

    let contractParams = (params || contract.args).slice();

    this.web3.eth.getAccounts(function (err, accounts) {
      if (err) {
        return callback(new Error(err));
      }

      // TODO: probably needs to be defaultAccount
      // TODO: it wouldn't necessary be the first address
      // use defined blockchain address or first address
      contractParams.push({
        //from: this.web3.eth.coinbase,
        from: accounts[0],
        data: "0x" + contract.code,
        gas: contract.gas,
        gasPrice: contract.gasPrice
      });

      self.logger.info("deploying " + contract.className.bold.cyan + " with ".green + contract.gas + " gas".green);
      contractParams.push(function (err, transaction) {
        self.logger.contractsState(self.contractsManager.contractsState());

        if (err) {
          self.logger.error("error deploying contract: " + contract.className.cyan);
          let errMsg = err.toString();
          if (errMsg === 'Error: The contract code couldn\'t be stored, please check your gas amount.') {
            errMsg = 'The contract code couldn\'t be stored, out of gas or constructor error';
          }
          self.logger.error(errMsg);
          contract.error = errMsg;
          return callback(new Error(err));
        } else if (transaction.address !== undefined) {
          self.logger.info(contract.className.bold.cyan + " deployed at ".green + transaction.address.bold.cyan);
          contract.deployedAddress = transaction.address;
          contract.transactionHash = transaction.transactionHash;
          return callback(null, transaction.address);
        }
      });

      contractObject["new"].apply(contractObject, contractParams);
    });
  }

  deployAll(done) {
    let self = this;
    this.logger.info("deploying contracts");

    async.eachOfSeries(this.contractsManager.listContracts(),
      function (contract, key, callback) {
        self.logger.trace(arguments);
        self.checkAndDeployContract(contract, null, callback);
      },
      function (err, results) {
        if (err) {
          self.logger.error("error deploying contracts");
          self.logger.error(err.message);
          self.logger.debug(err.stack);
        }
        self.logger.info("finished deploying contracts");
        self.logger.trace(arguments);
        done();
      }
    );

  }
}

module.exports = Deploy;
