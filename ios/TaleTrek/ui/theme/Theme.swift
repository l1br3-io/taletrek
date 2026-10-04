import SwiftUI
import UIKit

/// The two-theme token set from `desktop-ux-refresh`, scaffolded for
/// iOS: Dark for dark mode (warm near-black + amber — "phosphor ink"),
/// Sepia for light (tractor-feed cream + phosphor green). Exact hexes;
/// richer token work rides later polish efforts.
enum Theme {
    private static func color(_ dark: UInt32, _ sepia: UInt32) -> Color {
        Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : sepia
            return Theme.rgb(hex)
        })
    }

    private static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xff) / 255.0,
            green: CGFloat((hex >> 8) & 0xff) / 255.0,
            blue: CGFloat(hex & 0xff) / 255.0,
            alpha: 1
        )
    }

    /// Page background.
    static let background = color(0x0E0D0B, 0xF2EDE0)
    /// One step up — the transport strip.
    static let surface = color(0x16140F, 0xE8E1D0)
    /// Body text.
    static let foreground = color(0xE8E4D8, 0x2A3328)
    /// Secondary text — numbers, hints, "Now reading".
    static let muted = color(0x8A8474, 0x6A7560)
    /// Hairlines.
    static let line = color(0x2A2620, 0xC9C0A8)
    /// Amber / phosphor green.
    static let accent = color(0xE8A838, 0x4A7A3A)
    /// The spoken-paragraph wash — accent, held well back from the text.
    static let accentWash = color(0x211E16, 0xDDD4BE)
}
