// @ts-ignore
import * as d3 from "d3"
import Blocks from "./Blocks";
import { Block } from "./interfaces/Block";
import { PropagationTime } from "./interfaces/PropagationTime";
import { ChartData } from "./interfaces/ChartData";
import { Histogram } from "./interfaces/Histogram";
import { HistogramEntry } from "./interfaces/HistogramEntry";
import { Miner } from "./interfaces/Miner";
import { BlockWrapper } from "./interfaces/BlockWrapper";
import { padArray } from "./utils/padArray";
import { cfg } from "./utils/config";
import { compareBlocks } from "./utils/compareBlocks";
import { compareForks } from "./utils/compareForks";
import { Address } from "./interfaces/Address"
import { getContracts } from "./ContractKit"
import { IDictionary } from "./interfaces/IDictionary"

export default class History {

  private blocks: Blocks = new Blocks()

  public addBlock(
    id: Address,
    block: Block,
    trusted: boolean,
    addingHistory = false
  ): {
    block: Block,
    changed: boolean
  } {
    let changed = false

    if (
      block && block.uncles &&
      !isNaN(block.number) && block.number >= 0 &&
      block.transactions && block.difficulty
    ) {
      const historyBlock: BlockWrapper = this.blocks.search(block.number)
      let forkIndex = -1

      const now = Date.now()

      block.trusted = trusted
      block.arrived = now
      block.received = now
      block.propagation = 0
      block.fork = 0

      if (historyBlock) {
        // We already have a block with this height in collection

        // Check if node already checked this block height
        const propagationIndex = historyBlock.propagTimes.indexOf(
          historyBlock.propagTimes.find((p) => p.node === id)
        )

        // Check if node already check a fork with this height
        forkIndex = compareForks(historyBlock, block)

        if (propagationIndex === -1) {
          // Node didn't submit this block before
          if (forkIndex >= 0 && historyBlock.forks[forkIndex]) {
            // Found fork => update data
            block.arrived = historyBlock.forks[forkIndex].arrived
            block.propagation = now - historyBlock.forks[forkIndex].received
          } else {
            // No fork found => add a new one
            this.setBlockTime(block)

            forkIndex = historyBlock.forks.push(block) - 1
            historyBlock.forks[forkIndex].fork = forkIndex
          }

          // Push propagation time
          historyBlock.propagTimes.push({
            node: id,
            trusted: trusted,
            fork: forkIndex,
            received: now,
            propagation: block.propagation
          })
        } else {
          // Node submitted the block before
          if (forkIndex >= 0 && historyBlock.forks[forkIndex]) {
            // Matching fork found => update data
            block.arrived = historyBlock.forks[forkIndex].arrived

            if (forkIndex === historyBlock.propagTimes[propagationIndex].fork) {
              // Fork index is the same
              block.received = historyBlock.propagTimes[propagationIndex].received
              block.propagation = historyBlock.propagTimes[propagationIndex].propagation
            } else {
              // Fork index is different
              historyBlock.propagTimes[propagationIndex].fork = forkIndex
              historyBlock.propagTimes[propagationIndex].propagation =
                block.propagation = now - historyBlock.forks[forkIndex].received
            }

          } else {
            // No matching fork found => replace old one
            block.received = historyBlock.propagTimes[propagationIndex].received
            block.propagation = historyBlock.propagTimes[propagationIndex].propagation

            this.setBlockTime(block)

            forkIndex = historyBlock.forks.push(block) - 1
            historyBlock.forks[forkIndex].fork = forkIndex
          }
        }

        if (
          trusted &&
          !compareBlocks(
            historyBlock.block,
            historyBlock.forks[forkIndex]
          )
        ) {
          // If source is trusted update the main block
          historyBlock.forks[forkIndex].trusted = trusted
          historyBlock.block = historyBlock.forks[forkIndex]
        }

        block.fork = forkIndex

        changed = true

      } else if (
        this.blocks.length === 0 ||
        (this.blocks.length > 0 && block.number > this.blocks.worstBlockNumber()) ||
        (
          this.blocks.length < cfg.maxBlockHistory &&
          block.number < this.blocks.bestBlockNumber() &&
          addingHistory
        )
      ) {
        // Couldn't find block with this height
        this.setBlockTime(block)

        const blockWrapper: BlockWrapper = {
          block: block,
          forks: [block],
          signers: [],
          propagTimes: Array<PropagationTime>({
            node: id,
            trusted: trusted,
            fork: 0,
            received: now,
            propagation: block.propagation
          })
        }

        const contracts = getContracts()

        if (contracts) {
          (async () => {
            try {
              blockWrapper.signers = await contracts.election.getValidatorSigners(
                blockWrapper.block.number
              )
            } catch (err) {
              console.error('API', 'BLK', blockWrapper.block.number, err.message)
            }
          })()
        }

        this.saveBlock(blockWrapper)

        changed = true
      }

      return {
        block: block,
        changed: changed
      }
    }
  }

  private setBlockTime(block: Block) {
    // Getting previous max block
    const prevBlock: BlockWrapper = this.blocks.prevMaxBlock()

    if (prevBlock) {
      block.time = Math.max(block.arrived - prevBlock.block.arrived, 0)

      if (block.number < this.blocks.bestBlock().block.number) {
        block.time = Math.max((block.timestamp - prevBlock.block.timestamp) * 1000, 0)
      }
    } else {
      block.time = 0
    }
  }

  private saveBlock(
    block: BlockWrapper
  ): void {
    this.blocks
      .unshift(block)

    this.blocks = this.blocks.sort(
      (block1: BlockWrapper, block2: BlockWrapper) =>
        block2.block.number - block1.block.number
    )

    if (this.blocks.length > cfg.maxBlockHistory) {
      this.blocks.pop()
    }
  }

  public getNodePropagation(
    id: Address
  ): number[] {
    return this.blocks
      .slice(0, cfg.maxPeerPropagation)
      .map((block: BlockWrapper) => {

        const matches = block.propagTimes.filter(
          (propagationTime: PropagationTime) => propagationTime.node === id
        )

        if (matches.length > 0) {
          return matches[0].propagation
        }

        return -1
      })
  }

  public getLength(): number {
    return this.blocks.length;
  }

  public getBlockPropagation(): Histogram {
    const propagation: number[] = []
    let avgPropagation = 0

    for (const block of this.blocks) {
      for (const propagationTime of block.propagTimes) {
        const prop = Math.min(
          cfg.maxPropagationRange,
          propagationTime.propagation || -1
        )

        if (prop >= 0) {
          propagation.push(prop)
        }
      }
    }

    if (propagation.length > 0) {
      const sum = propagation.reduce((sum, p) => sum + p, 0)
      avgPropagation = Math.round(sum / propagation.length)
    }

    const data = d3.histogram()
      .domain([
        cfg.minPropagationRange,
        cfg.maxPropagationRange
      ])
      .thresholds(cfg.maxBins)
      (propagation)

    let freqCum = 0

    const histogram = data.map((val): HistogramEntry => {
      freqCum += val.length

      const cumPercent = (freqCum / Math.max(1, propagation.length))
      const y = val.length / propagation.length

      return {
        x: val.x0,
        dx: val.x1 - val.x0,
        y: isNaN(y) ? 0 : y,
        frequency: val.length,
        cumulative: freqCum,
        cumpercent: cumPercent
      }
    })

    return {
      histogram: histogram,
      avg: avgPropagation
    }
  }

  private getAvgBlocktime(): number {
    const blockTimes = this.blocks
      .map((item: BlockWrapper): number => {
        return item.block.time / 1000
      })

    const sum = blockTimes.reduce((sum, b) => sum + b, 0)

    return sum / (blockTimes.length === 0 ? 1 : blockTimes.length)
  }

  private getMinersCount(): Miner[] {
    return this.blocks
      .slice(0, cfg.maxBins)
      .map((item: BlockWrapper): Miner => {
        return {
          miner: item.block.miner,
          number: item.block.number
        }
      })
  }

  public getCharts(): ChartData {
    const chartHistory = this.blocks
      .slice(0, cfg.maxBins)
      .map((blockWrapper: BlockWrapper): {
        height: number
        blocktime: number
        difficulty: string
        uncles: number
        transactions: number
        gasSpending: number
        gasLimit: number
        miner: string
      } => {
        return {
          height: blockWrapper.block.number,
          blocktime: blockWrapper.block.time / 1000,
          difficulty: blockWrapper.block.difficulty,
          uncles: blockWrapper.block.uncles.length,
          transactions: blockWrapper.block.transactions ? blockWrapper.block.transactions.length : 0,
          gasSpending: blockWrapper.block.gasUsed,
          gasLimit: blockWrapper.block.gasLimit,
          miner: blockWrapper.block.miner
        }
      })

    return {
      height: chartHistory.map((h) => h.height),
      blocktime: padArray(chartHistory.map((h) => h.blocktime), cfg.maxBins, 0),
      avgBlocktime: this.getAvgBlocktime(),
      difficulty: chartHistory.map((h) => h.difficulty),
      uncles: chartHistory.map((h) => h.uncles),
      transactions: chartHistory.map((h) => h.transactions),
      gasSpending: padArray(chartHistory.map((h) => h.gasSpending), cfg.maxBins, 0),
      gasLimit: padArray(chartHistory.map((h) => h.gasLimit), cfg.maxBins, 0),
      miners: this.getMinersCount(),
      propagation: this.getBlockPropagation(),
    }
  }

  public getForks(): IDictionary {

    const forks: IDictionary = {}

    for (const block of this.blocks) {
      const b: IDictionary = {
        forks: block.forks.length
      }

      for (const forkedBlock of block.forks) {
        b[forkedBlock.hash] = {
          number: forkedBlock.number,
          miner: forkedBlock.miner
        }
      }

      forks[block.block.number] = b
    }

    return forks
  }
}
