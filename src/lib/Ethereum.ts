import { EventEmitter } from 'events'
import * as fetch from 'isomorphic-fetch'
import { RequestManager, ContractFactory, providers, Contract } from 'eth-connect'

import { IEthereumDataProvider } from './IEthereumDataProvider'
import { isDev, getProvider } from '../utils/env'
import { ErrorType, fail } from '../utils/errors'
import { Coords, getObject } from '../utils/coordinateHelpers'
import { filterAndFillEmpty } from '../utils/land'

import { abi as manaAbi } from '../../abi/MANAToken.json'
import { abi as landAbi } from '../../abi/LANDRegistry.json'
import { abi as estateAbi } from '../../abi/EstateRegistry.json'

const provider = process.env.RPC_URL || getProvider()
const providerInstance = new providers.HTTPProvider(provider)
const requestManager = new RequestManager(providerInstance)
providerInstance.debug = !!process.env.DEBUG

const manaFactory = new ContractFactory(requestManager, manaAbi)
const landFactory = new ContractFactory(requestManager, landAbi)
const estateFactory = new ContractFactory(requestManager, estateAbi)

const factories = new Map<String, ContractFactory>()
factories.set('MANAToken', manaFactory)
factories.set('LANDProxy', landFactory)
factories.set('EstateProxy', estateFactory)

export type LANDData = {
  version?: number
  name: string
  description: string
}

/**
 * Events emitted by this class:
 *
 */
export class Ethereum extends EventEmitter implements IEthereumDataProvider {
  private static addresses: any
  private static contracts = new Map<string, Contract>()

  static async getContractAddresses(): Promise<any> {
    if (this.addresses) {
      return this.addresses
    }

    try {
      const raw = await fetch('https://contracts.decentraland.org/addresses.json')
      this.addresses = await raw.json()
      return this.addresses
    } catch (error) {
      fail(
        ErrorType.ETHEREUM_ERROR,
        `Unable to fetch decentraland contracts from "https://contracts.decentraland.org/addresses.json", error: ${error.message}`
      )
    }
  }

  static async getContractAddress(name: string): Promise<string> {
    const addresses = await this.getContractAddresses()
    return addresses[isDev ? 'ropsten' : 'mainnet'][name]
  }

  static async getContract(name: string): Promise<Contract> {
    if (this.contracts.get(name)) {
      return this.contracts.get(name)
    }

    const address = await this.getContractAddress(name)
    const factory = factories.get(name)
    const contract = await factory.at(address)
    this.contracts.set(name, contract)
    return contract
  }

  async getLandOf(address: string): Promise<Coords[]> {
    const contract = await Ethereum.getContract('LANDProxy')
    try {
      const [x, y] = await contract['landOf'](address.toUpperCase())
      return x.map(($, i) => ({ x: $.toNumber(), y: y[i].toNumber() }))
    } catch (e) {
      fail(ErrorType.ETHEREUM_ERROR, `Unable to fetch LANDs: ${e.message}`)
    }
  }

  async getEstatesOf(address: string): Promise<number[]> {
    const contract = await Ethereum.getContract('EstateProxy')
    try {
      const balance = await contract['balanceOf'](address)
      const requests = []
      for (let i = 0; i < balance; i++) {
        const request = contract['tokenOfOwnerByIndex'](address, i)
        requests.push(request)
      }
      return Promise.all(requests)
    } catch (e) {
      fail(ErrorType.ETHEREUM_ERROR, `Unable to fetch Estate IDs of owner: ${e.message}`)
    }
  }

  async getLandData({ x, y }: Coords): Promise<LANDData> {
    const contract = await Ethereum.getContract('LANDProxy')
    try {
      const landData = await contract['landData'](x, y)
      return filterAndFillEmpty(this.decodeLandData(landData))
    } catch (e) {
      fail(ErrorType.ETHEREUM_ERROR, `Unable to fetch LAND data: ${e.message}`)
    }
  }

  async getEstateData(estateId: number): Promise<LANDData> {
    const contract = await Ethereum.getContract('EstateProxy')
    try {
      const landData = await contract['getMetadata'](estateId)
      return filterAndFillEmpty(this.decodeLandData(landData))
    } catch (e) {
      fail(ErrorType.ETHEREUM_ERROR, `Unable to fetch LAND data: ${e.message}`)
    }
  }

  async getLandOwner({ x, y }: Coords): Promise<string> {
    const contract = await Ethereum.getContract('LANDProxy')
    try {
      return await contract['ownerOfLand'](x, y)
    } catch (e) {
      fail(ErrorType.ETHEREUM_ERROR, `Unable to fetch LAND owner: ${e.message}`)
    }
  }

  async getEstateOwner(estateId: number): Promise<string> {
    const contract = await Ethereum.getContract('EstateProxy')
    try {
      return await contract['ownerOf'](estateId)
    } catch (e) {
      fail(ErrorType.ETHEREUM_ERROR, `Unable to fetch LAND owner: ${e.message}`)
    }
  }

  async validateAuthorization(owner: string, parcels: Coords[]) {
    const validations = parcels.map(parcel => this.validateAuthorizationOfParcel(owner, parcel))
    return Promise.all(validations)
  }

  /**
   * It fails if the owner address isn't able to update given parcel (as an owner or operator)
   */
  async validateAuthorizationOfParcel(owner: string, parcel: Coords): Promise<void> {
    const isLandOperator = await this.isLandOperator(parcel, owner)
    if (!isLandOperator) {
      fail(ErrorType.ETHEREUM_ERROR, `Provided address ${owner} is not authorized to update LAND ${parcel.x},${parcel.y}`)
    }
  }

  async getLandOfEstate(estateId: number): Promise<Coords[]> {
    const contract = await Ethereum.getContract('EstateProxy')
    const landContract = await Ethereum.getContract('LANDProxy')

    try {
      const estateSize = await contract['getEstateSize'](estateId)
      let promiseParcels = []

      for (let i = 0; i < estateSize; i++) {
        const request = contract['estateLandIds'](estateId, i).then(p => {
          return landContract['decodeTokenId']([p])
        })
        promiseParcels.push(request)
      }

      const parcels = (await Promise.all(promiseParcels)).map(data => getObject(data))

      return parcels
    } catch (e) {
      fail(ErrorType.ETHEREUM_ERROR, `Unable to fetch LANDs of Estate: ${e.message}`)
    }
  }

  async getEstateIdOfLand({ x, y }: Coords): Promise<number> {
    const contract = await Ethereum.getContract('EstateProxy')
    const landContract = await Ethereum.getContract('LANDProxy')

    try {
      const assetId = await landContract['encodeTokenId'](x, y)
      return await contract['getLandEstateId'](assetId)
    } catch (e) {
      fail(ErrorType.ETHEREUM_ERROR, `Unable to fetch Estate ID of LAND: ${e.message}`)
    }
  }

  private async isLandOperator(coords: Coords, owner: string): Promise<boolean> {
    const contract = await Ethereum.getContract('LANDProxy')

    const estate = await this.getEstateIdOfLand(coords)

    if (estate && estate > 0) {
      return this.isEstateOperator(estate, owner)
    }

    try {
      const { x, y } = coords
      const assetId = await contract['encodeTokenId'](x, y)
      return await contract['isUpdateAuthorized'](owner.toLowerCase(), assetId.toString())
    } catch (e) {
      fail(ErrorType.ETHEREUM_ERROR, `Unable to fetch LAND authorization: ${JSON.stringify(e)}`)
    }
  }

  private async isEstateOperator(estateId: number, owner: string): Promise<boolean> {
    const contract = await Ethereum.getContract('EstateProxy')
    try {
      return await contract['isUpdateAuthorized'](owner, estateId)
    } catch (e) {
      fail(ErrorType.ETHEREUM_ERROR, `Unable to fetch Estate authorization: ${e.message}`)
    }
  }

  private decodeLandData(data: string = ''): LANDData {
    // this logic can also be found in decentraland-eth, but we can't rely on node-hid

    if (data === '') {
      return null
    }

    const [, name, description] = data.split(',').map(field => {
      return field.slice(1, -1)
    })

    return { version: 0, name: name || null, description: description || null }
  }
}
