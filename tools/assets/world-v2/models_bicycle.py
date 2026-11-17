"""The bicycle: an old steel Dutch roadster, the island's quiet way across (docs/game-design.md, "getting across it").

Proportions from a traditional opafiets (Wikimedia Commons, "Dutch bicycle.jpg"): 28-inch wheels 1.12 m apart, the bottom
bracket 30 cm up, a long head tube at 72 degrees with a curved fork, swept-back bars whose grips sit about 5 cm above the
sprung saddle, a double top tube, a rack over the rear wheel, full mudguards, a chain case and a lamp on the head tube. Coaster
brake, so no levers.

Four assets, because three of its parts move in the game: the frame (with the saddle, rack, rear mudguard, chain case, lamp and
stand), the steering fork (with the stem, bars, bell and front mudguard), a wheel (used front and back) and the cranks.
Everything but the wheel and the cranks is authored in the frame's coordinates (metres, y up, the bike pointing to +z, its
wheels on the ground at y=0); the wheel and the cranks are authored about their own axle (along x, through the origin). The
frame's hooks say where each moving part goes: the axles, the steering axis (the fork turns about steer_bottom -> steer_top),
the bottom bracket, the saddle and the bars (where the rider's body and hands go) and the rack (where a heavy part is strapped).

Every tube ends inside the tube or plate it is brazed or bolted to: the ends are computed from the named joints below, never
placed by eye.
"""
import math

import numpy as np

from kit import Model, norm

# --- Geometry, in the frame's coordinates ---------------------------------------------------------------------------------
AXLE_Y = .355
REAR = np.array((0, AXLE_Y, -.56))
FRONT = np.array((0, AXLE_Y, .56))
DROP_X = .065                            # rear dropouts either side of a 13 cm hub
BB = np.array((0, .30, -.08))
SEAT = np.array((0, .83, -.285))         # top of the seat tube: the seat lug
SEAT_DIR = norm(SEAT - BB)               # 69 degrees
HEAD_TOP = np.array((0, .90, .315))
HEAD_BOTTOM = np.array((0, .72, .375))
STEER = norm(HEAD_TOP - HEAD_BOTTOM)     # the steering axis, up and back: 72 degrees, the fork's rake is 6 cm
TYRE_R, TYRE_T = .333, .022              # wheel: tyre centre radius and section radius (outside .355)
GUARD_R = TYRE_R + TYRE_T + .013         # mudguards ride 1.3 cm over the tyre
T = .0145                                # main tube radius (1 1/8 inch)
RACK_Y = .79
RACK_FRONT, RACK_BACK = -.305, -.85
POST_TOP = SEAT + SEAT_DIR * .11          # 11 cm of seat post shows
SADDLE_TOP = .985                        # the saddle's crown; the grips are at about 1.03


def on_tube(a, b, y):
    """The point on the straight tube a->b at height y (for joints part way along a tube)."""
    t = (y - a[1]) / (b[1] - a[1])
    return a + (b - a) * t


def _mudguard(m, centre, a0, a1, width=.054):
    """A rolled steel mudguard over a wheel: a shallow crowned channel, angles in degrees from straight ahead (+z) round through up."""
    a0, a1 = math.radians(a0), math.radians(a1)

    def guard(u, v):
        a = a0 + (a1 - a0) * u
        x = (v - .5) * width
        rr = GUARD_R + .009 * (1 - (2 * v - 1) ** 2)
        return np.array((x, centre[1] + math.sin(a) * rr, centre[2] + math.cos(a) * rr))

    m.surface("olive", guard, 36, 4, (abs(a1 - a0) * GUARD_R * 2, width * 2), wear=lambda u, v: .25 * (1 - u))
    m.surface("olive", guard, 36, 4, (abs(a1 - a0) * GUARD_R * 2, width * 2), flip=True, density=.4)


def guard_point(centre, angle_deg, x=0.0, lift=0.0):
    a = math.radians(angle_deg)
    return np.array((x, centre[1] + math.sin(a) * (GUARD_R + lift), centre[2] + math.cos(a) * (GUARD_R + lift)))


def frame():
    m = Model("bicycle", tex=2048, seed=401)
    # --- The main frame, brazed into lugs. The joints are on the tubes' axes, so every end sits inside the tube it meets.
    head_top_tube = HEAD_TOP - STEER * .028
    head_low_tube = HEAD_TOP - STEER * .085
    head_down = HEAD_BOTTOM + STEER * .03
    seat_top_tube = SEAT - SEAT_DIR * .03
    seat_low_tube = SEAT - SEAT_DIR * .09
    m.tube([head_top_tube, seat_top_tube], T, "olive", 10)                  # top tube
    m.tube([head_low_tube, seat_low_tube], T * .8, "olive", 10)             # the second top tube of a Dutch frame
    m.tube([head_down, BB + np.array((0, .006, .012))], T * 1.12, "olive", 10)   # down tube
    m.tube([BB, SEAT + SEAT_DIR * .012], T, "olive", 10)                     # seat tube
    m.cyl(HEAD_BOTTOM - STEER * .01, HEAD_TOP + STEER * .01, T * 1.3, "olive", 12)   # head tube
    for p, d, r in ((HEAD_TOP, STEER, .0205), (HEAD_BOTTOM, STEER, .0215), (SEAT, SEAT_DIR, .0185)):
        m.cyl(p - d * .014, p + d * .014, r, "chrome", 12)                   # lug bands
    m.cyl(BB + np.array((-.04, 0, 0)), BB + np.array((.04, 0, 0)), .021, "olive", 12)   # bottom bracket shell
    # Rear triangle: the stays leave the seat lug and the bottom bracket either side and end in the dropout plates.
    stay_top = SEAT - SEAT_DIR * .022
    for s in (-1, 1):
        drop = REAR + np.array((s * DROP_X, 0, 0))
        m.box(drop + np.array((0, .012, .012)), (.008, .06, .06), "steel", chamfer=.003)           # dropout plate
        m.bolt(drop + np.array((s * .006, 0, 0)), (s, 0, 0), .009, "chrome")                       # axle nut
        m.tube([stay_top + np.array((s * .02, 0, 0)), drop + np.array((0, .03, .018))], .0085, "olive", 8)      # seat stay
        m.tube([BB + np.array((s * .028, 0, -.012)), BB + np.array((s * .045, .006, -.13)), drop + np.array((0, .004, .03))], .0095, "olive", 8)   # chainstay
    bridge = on_tube(stay_top, REAR + np.array((0, .03, .018)), .74)
    m.tube([bridge + np.array((-.022, 0, 0)), bridge + np.array((.022, 0, 0))], .0065, "olive", 6)   # seat stay bridge
    m.cyl(REAR + np.array((-DROP_X - .006, 0, 0)), REAR + np.array((DROP_X + .006, 0, 0)), .0065, "steel_bare", 8)   # axle
    # --- Seat post and a sprung leather saddle. The springs stand between the rails and the saddle's frame, under the leather.
    m.cyl(SEAT, POST_TOP, .0125, "chrome", 10)
    m.cyl(SEAT - SEAT_DIR * .006, SEAT + SEAT_DIR * .026, .0165, "olive", 10)                # seat lug's binder
    clamp = POST_TOP + np.array((0, .008, 0))
    m.box(clamp, (.03, .022, .04), "steel_bare", chamfer=.004)                               # rail clamp on the post
    rail_y = clamp[1] + .006
    nose = np.array((0, SADDLE_TOP - .022, POST_TOP[2] + .135))
    back = POST_TOP[2] - .062   # the springs stand under the saddle's back, inside its outline
    spring_base, spring_top = rail_y + .002, SADDLE_TOP - .03
    for s in (-1, 1):
        # The rails run from the nose bolt, through the clamp, out to the spring seats at the back.
        m.tube([nose + np.array((s * .008, -.004, -.01)), np.array((s * .022, rail_y, POST_TOP[2] + .03)), np.array((s * .042, rail_y, back + .015)), np.array((s * .05, spring_base, back))], .0038, "steel_bare", 6)
        coil = [np.array((s * .05 + .011 * math.cos(t), spring_base + (spring_top - spring_base) * t / (8 * math.pi), back + .011 * math.sin(t))) for t in np.linspace(0, 8 * math.pi, 64)]
        m.tube(coil, .0026, "steel_bare", 5)
    m.tube([np.array((-.058, spring_top + .002, back)), np.array((0, spring_top + .006, back - .012)), np.array((.058, spring_top + .002, back))], .0042, "steel_bare", 6)   # cantle plate's wire
    m.tube([nose + np.array((0, -.004, -.004)), nose + np.array((0, -.002, -.06))], .0042, "steel_bare", 6)   # nose bolt

    def outline(th):
        # The saddle's plan: a nose in front (+z), wide and rounded at the back.
        along = math.cos(th)
        half = .022 + .084 * ((1 - along) / 2) ** .9
        return math.sin(th) * half, POST_TOP[2] + .015 + along * (.12 if along > 0 else .115)

    def leather(u, v):
        # u round the rim, v from the rim (0) to the crown's centre (1): a domed top that closes over itself, the nose a little lower.
        th = u * 2 * math.pi
        x, z = outline(th)
        k = 1 - v
        cz = POST_TOP[2] + .01
        rim_y = SADDLE_TOP - .026 - .006 * max(0.0, (z - cz) / .12)
        return np.array((x * k ** .5, rim_y + .026 * (1 - k ** 2.2), cz + (z - cz) * k ** .5))

    def skirt(u, v):
        th = u * 2 * math.pi
        x, z = outline(th)
        cz = POST_TOP[2] + .01
        rim_y = SADDLE_TOP - .026 - .006 * max(0.0, (z - cz) / .12)
        return np.array((x * (1 - .05 * v), rim_y - .02 * v, cz + (z - cz) * (1 - .03 * v)))

    m.surface("rubber", leather, 44, 8, (.9, .35))
    m.surface("rubber", skirt, 44, 2, (.9, .1))
    # --- Rear rack: a deck over the wheel, its front on the seat stays, two pairs of stays down to the dropouts.
    for s in (-1, 1):
        m.tube([(s * .07, RACK_Y, RACK_FRONT), (s * .07, RACK_Y, RACK_BACK), (s * .035, RACK_Y - .01, RACK_BACK - .018)], .0055, "steel", 6)
        eye = REAR + np.array((s * (DROP_X + .006), .022, -.01))
        m.tube([(s * .07, RACK_Y - .004, RACK_BACK + .03), eye], .0052, "steel", 6)
        m.tube([(s * .07, RACK_Y - .004, -.6), eye + np.array((0, .006, .014))], .0048, "steel", 6)
    m.tube([(-.035, RACK_Y - .01, RACK_BACK - .018), (.035, RACK_Y - .01, RACK_BACK - .018)], .0055, "steel", 6)
    front_bar = on_tube(stay_top, REAR + np.array((0, .03, .018)), RACK_Y - .004)
    m.tube([(-.07, RACK_Y, RACK_FRONT), (.07, RACK_Y, RACK_FRONT)], .0055, "steel", 6)
    for s in (-1, 1):   # the front of the deck bolted to the seat stays
        m.box(np.array((s * .045, (RACK_Y + front_bar[1]) / 2, (RACK_FRONT + front_bar[2]) / 2)), (.05, .012, .03), "steel", chamfer=.003)
    for z in np.linspace(RACK_FRONT - .07, RACK_BACK + .03, 6):
        m.tube([(-.07, RACK_Y + .004, z), (.07, RACK_Y + .004, z)], .0042, "steel", 6)
    # --- Rear mudguard over the top and back of the wheel, held by the bridge and two stays; a red reflector on its tail.
    _mudguard(m, REAR, 62, 205)
    top_of_guard = guard_point(REAR, 104)
    m.tube([bridge, top_of_guard + np.array((0, .008, 0))], .005, "steel", 6)
    for s in (-1, 1):
        m.tube([REAR + np.array((s * (DROP_X + .006), -.008, -.012)), guard_point(REAR, 168, s * .024, -.003)], .0028, "steel_bare", 5)
    tail = guard_point(REAR, 172, 0, .004)
    out = norm(tail - REAR)
    m.cyl(tail, tail + out * .016, .026, "red", 14)
    # --- Chain: from the chainring (radius .095) to the sprocket (.04), on the right; a chain case over its top run and the ring.
    cx = .057
    loop = [np.array((cx, BB[1] + .097, BB[2])), np.array((cx, REAR[1] + .042, REAR[2]))]
    loop += [np.array((cx, REAR[1] + math.sin(a) * .042, REAR[2] + math.cos(a) * .042)) for a in np.linspace(math.pi / 2, 3 * math.pi / 2, 9)][1:-1]
    loop += [np.array((cx, REAR[1] - .042, REAR[2])), np.array((cx, BB[1] - .097, BB[2]))]
    loop += [np.array((cx, BB[1] + math.sin(a) * .097, BB[2] + math.cos(a) * .097)) for a in np.linspace(-math.pi / 2, math.pi / 2, 13)][1:]
    m.tube(loop, .0042, "soot_iron", 5)
    m.cyl(REAR + np.array((cx - .006, 0, 0)), REAR + np.array((cx + .006, 0, 0)), .044, "soot_iron", 16)   # sprocket

    def case(u, v):
        # A half chain case seen from the side: a long rounded shape round the ring (r .125) and the sprocket (r .065), its
        # outer face at x = cx + .025, rolled in over the chain at the top. u runs round the outline, v from the face (0) in.
        th = u * 2 * math.pi
        if math.cos(th) >= 0:   # front half: round the chainring
            c, r = BB, .125
        else:
            c, r = REAR, .065
        p = np.array((cx + .025 - .022 * v, c[1] + math.sin(th) * r, c[2] + math.cos(th) * r))
        if abs(math.cos(th)) < .2:   # the straight runs between the two ends
            t = (math.cos(th) + .2) / .4
            y_top = REAR[1] + .065 + (BB[1] + .125 - REAR[1] - .065) * t
            y_bot = REAR[1] - .065 + (BB[1] - .125 - REAR[1] + .065) * t
            z = REAR[2] + (BB[2] - REAR[2]) * t
            p = np.array((p[0], y_top if math.sin(th) > 0 else y_bot, z))
        return p

    # Black enamel, as such cases were. The weathered metal recipes age a plate this size into a brown board (tried olive and
    # steel); the flat matte black reads as old enamel.
    m.surface("rubber", case, 48, 2, (1.2, .1))
    mid_y = (BB[1] + REAR[1]) / 2

    def face(u, v):
        # The flat outer face: each rim point drawn straight up or down to the case's middle line.
        p = case(u, 0)
        return np.array((p[0], p[1] + (mid_y - p[1]) * v, p[2]))

    m.surface("rubber", face, 48, 3, (1.2, .3))
    m.surface("rubber", face, 48, 3, (1.2, .3), flip=True, density=.3)
    m.cyl(BB + np.array((.074, 0, 0)), BB + np.array((.086, 0, 0)), .03, "chrome", 16)   # the case's ring round the spindle
    m.cyl(BB + np.array((.04, 0, 0)), BB + np.array((.075, 0, 0)), .016, "steel_bare", 12)   # bearing cup out to the case
    for p in (BB + np.array((.032, .02, -.12)), REAR + np.array((.07, .03, .06))):
        m.tube([p, p + np.array((.02, 0, 0))], .004, "steel_bare", 5)   # the case's two brackets
    # --- Lamp on a bracket off the front of the head tube, well above the mudguard; a stand on the left chainstay.
    on_head = HEAD_TOP - STEER * .05
    lamp = on_head + np.array((0, .005, .078))
    m.box(on_head + np.array((0, .0, .028)), (.018, .02, .05), "steel", chamfer=.003)
    m.lathe([(.0, 0), (.028, .02), (.034, .55), (.037, .93), (.034, 1)], lamp + np.array((0, 0, -.04)), lamp + np.array((0, 0, .035)), "chrome", 16)
    m.cyl(lamp + np.array((0, 0, .033)), lamp + np.array((0, 0, .039)), .031, "glass", 16)
    stand_top = BB + np.array((-.045, .004, -.13))
    m.tube([stand_top, np.array((-.15, .014, -.27))], .008, "steel", 6)
    m.box((-.152, .007, -.276), (.03, .014, .045), "rubber", chamfer=.003)
    m.box(stand_top + np.array((-.006, 0, 0)), (.016, .03, .04), "steel", chamfer=.003)
    # --- Hooks for the moving parts and the rider.
    m.hook("rear_axle", REAR)
    m.hook("front_axle", FRONT)
    m.hook("steer_top", HEAD_TOP)
    m.hook("steer_bottom", HEAD_BOTTOM)
    m.hook("crank", BB)
    m.hook("saddle", (0, SADDLE_TOP + .005, POST_TOP[2] - .01))
    m.hook("bars", (0, 1.03, .06))
    m.hook("rack", (0, RACK_Y + .01, (RACK_FRONT + RACK_BACK) / 2))
    m.hook("lamp", lamp + np.array((0, 0, .04)))
    m.radius = 1.2
    return m


def fork():
    """Fork, stem, swept-back bars, bell and front mudguard, in the frame's coordinates: the game turns it about the steering axis."""
    m = Model("bicycle_fork", tex=1024, seed=402)
    crown = HEAD_BOTTOM - STEER * .022
    steer_top = HEAD_TOP + STEER * .03
    m.cyl(crown, steer_top, .0115, "chrome", 10)                                                # steerer, through the head tube
    m.cyl(steer_top - STEER * .012, steer_top + STEER * .006, .019, "chrome", 12)              # locknut
    m.box(crown - STEER * .004, (.112, .024, .036), "olive", chamfer=.008)                    # crown
    for s in (-1, 1):
        drop = FRONT + np.array((s * .05, 0, 0))
        blade = [crown + np.array((s * .044, -.006, 0)), crown + np.array((s * .047, 0, 0)) - STEER * .2, np.array((s * .05, .45, .5)), np.array((s * .05, .385, .545)), drop + np.array((0, .01, 0))]
        m.tube(blade, .0105, "olive", 8)
        m.box(drop, (.008, .036, .036), "steel", chamfer=.003)
        m.bolt(drop + np.array((s * .006, 0, 0)), (s, 0, 0), .009, "chrome")
    m.cyl(FRONT + np.array((-.058, 0, 0)), FRONT + np.array((.058, 0, 0)), .0065, "steel_bare", 8)   # axle
    # Quill stem: up out of the steerer, then forward to the bar clamp. The bars sweep back to grips 5 cm above the saddle.
    quill_top = steer_top + STEER * .065
    clamp = quill_top + np.array((0, .006, .045))
    m.cyl(steer_top, quill_top, .0112, "chrome", 10)
    m.tube([quill_top - STEER * .01, quill_top + np.array((0, .004, .02)), clamp], .0115, "chrome", 10)
    m.cyl(clamp + np.array((-.028, 0, 0)), clamp + np.array((.028, 0, 0)), .0148, "chrome", 12)
    grips = []
    for s in (-1, 1):
        bar = [clamp, clamp + np.array((s * .12, .004, .01)), clamp + np.array((s * .22, .014, -.03)), clamp + np.array((s * .265, .022, -.12)), clamp + np.array((s * .275, .025, -.2))]
        m.tube(bar, .0115, "chrome", 10)
        g0 = bar[-1] + np.array((s * .002, 0, .012))
        g1 = g0 + np.array((s * .004, -.002, -.115))
        m.lathe([(.0125, 0), (.0168, .04), (.0162, .9), (.0178, .96), (.0, 1)], g0, g1, "rubber", 12)
        grips.append((g0 + g1) / 2)
    # Bell on the left bar, by the stem.
    bell = clamp + np.array((-.1, .012, .005))
    m.box(bell + np.array((0, -.014, 0)), (.012, .012, .03), "chrome", chamfer=.002)
    m.lathe([(.0, 0), (.026, .05), (.028, .35), (.022, .8), (.008, .97), (0, 1)], bell, bell + np.array((0, .028, 0)), "chrome", 18)
    m.box(bell + np.array((.022, .004, .0)), (.016, .004, .008), "steel_bare", chamfer=.001)
    # Front mudguard from behind the wheel, over the top, to past the front; a tab to the crown and stays to the fork ends.
    _mudguard(m, FRONT, 196, 16)
    m.tube([crown - STEER * .012, guard_point(FRONT, 118, 0, .004)], .006, "steel", 6)
    for s in (-1, 1):
        m.tube([FRONT + np.array((s * .056, -.006, .012)), guard_point(FRONT, 26, s * .024, -.003)], .0028, "steel_bare", 5)
    m.hook("bell", bell)
    m.hook("grip_left", grips[0])
    m.hook("grip_right", grips[1])
    m.radius = .8
    return m


def wheel():
    """One wheel about its own axle (x): tyre, chromed rim, 32 spokes crossing three, hub. Used front and back."""
    m = Model("bicycle_wheel", tex=1024, seed=403)

    def tyre(u, v):
        th, ph = u * 2 * math.pi, v * 2 * math.pi
        R = TYRE_R + TYRE_T * math.cos(ph) * .92
        return np.array((TYRE_T * .82 * math.sin(ph), math.sin(th) * R, math.cos(th) * R))

    m.surface("tyre", tyre, 72, 8, (14, .6))
    rim_r = TYRE_R - TYRE_T * .75

    def rim(u, v):
        th = u * 2 * math.pi
        x = (v - .5) * .03
        r = rim_r - .007 * (1 - (2 * v - 1) ** 2) - .004
        return np.array((x, math.sin(th) * r, math.cos(th) * r))

    m.surface("chrome", rim, 64, 4, (12, .1), flip=True)
    m.lathe([(.0, 0), (.009, .02), (.026, .06), (.026, .2), (.014, .3), (.014, .7), (.026, .8), (.026, .94), (.009, .98), (0, 1)], (-.055, 0, 0), (.055, 0, 0), "chrome", 16)
    for i in range(32):
        side = 1 if i % 2 else -1
        a_hub = i * 2 * math.pi / 32
        a_rim = a_hub + side * (3 * 2 * math.pi / 16) * (1 if i % 4 < 2 else -1) * .5
        hub = np.array((side * .044, math.sin(a_hub) * .022, math.cos(a_hub) * .022))
        tip = np.array((side * .004, math.sin(a_rim) * (rim_r - .012), math.cos(a_rim) * (rim_r - .012)))
        m.tube([hub, tip], .0013, "steel_bare", 4)
    valve = np.array((0, math.sin(.4) * (rim_r - .01), math.cos(.4) * (rim_r - .01)))
    m.cyl(valve, valve * (1 - .06 / np.linalg.norm(valve)), .0035, "chrome", 6)
    m.radius = .4
    return m


def crank():
    """Chainring, cranks and pedals about the bottom bracket's axle (x). The spindle runs through the bracket shell and out
    through the chain case on the right, so both cranks sit outside everything: the right one outside the case (its face is
    at x = .082), the left one outside the shell. Each pedal turns on its own axle out of the crank's eye. Turned in the game
    with the rear wheel through the gearing (a 46-tooth ring, an 18-tooth sprocket: the cranks turn once for every 2.56 turns
    of the wheel)."""
    m = Model("bicycle_crank", tex=1024, seed=404)
    cx = .057
    right_x, left_x = .104, -.06
    m.cyl((left_x - .01, 0, 0), (right_x + .01, 0, 0), .0105, "steel_bare", 10)                    # spindle, end to end
    for x in (left_x - .012, right_x + .012):
        m.cyl((x - .004, 0, 0), (x + .004, 0, 0), .009, "chrome", 8)                            # crank bolts

    def ring(u, v):
        th, r = u * 2 * math.pi, .07 + v * .032
        tooth = .0035 * (v > .95) * (1 if int(u * 46) % 2 else 0)
        return np.array((cx, math.sin(th) * (r + tooth), math.cos(th) * (r + tooth)))

    m.surface("steel_bare", ring, 92, 3, (2.5, .1))
    m.surface("steel_bare", lambda u, v: ring(u, v) + np.array((.004, 0, 0)), 92, 3, (2.5, .1), flip=True)
    m.cyl((cx - .004, 0, 0), (cx + .008, 0, 0), .02, "steel_bare", 12)                          # the ring's boss on the spindle
    for i in range(5):
        a = i * 2 * math.pi / 5
        m.beam((cx + .002, 0, 0), (cx + .002, math.sin(a) * .074, math.cos(a) * .074), .014, .006, "steel_bare", up=(1, 0, 0), chamfer=.002)
    for s, a, x in ((1, -math.pi / 2, right_x), (-1, math.pi / 2, left_x)):
        eye = np.array((x, math.sin(a) * .17, math.cos(a) * .17))
        m.cyl((x - .009, 0, 0), (x + .009, 0, 0), .02, "chrome", 12)                            # the crank's boss, round the spindle
        m.beam((x, 0, 0), eye, .022, .014, "chrome", up=(1, 0, 0), chamfer=.004)
        m.cyl(eye - np.array((.009, 0, 0)), eye + np.array((.009, 0, 0)), .013, "chrome", 10)  # the eye the pedal screws into
        axle_end = eye + np.array((s * .1, 0, 0))
        m.cyl(eye, axle_end, .0065, "steel_bare", 8)                                            # pedal axle
        pedal = eye + np.array((s * .058, 0, 0))
        for z in (-.026, .026):
            m.box(pedal + np.array((0, 0, z)), (.09, .016, .012), "rubber", chamfer=.004)        # the two rubber blocks
        for x_ in (-.042, .042):
            m.box(pedal + np.array((x_, 0, 0)), (.006, .018, .064), "steel", chamfer=.002)       # the cage's end plates
        m.cyl(pedal - np.array((.045, 0, 0)), pedal + np.array((.045, 0, 0)), .011, "steel", 10)   # the pedal's body round its axle
    m.radius = .3
    return m


ASSETS = {"bicycle": (frame, None), "bicycle_fork": (fork, None), "bicycle_wheel": (wheel, None), "bicycle_crank": (crank, None)}
